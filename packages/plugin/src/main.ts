import { diffLines, HttpRemote, isSyncablePath, Runner, splitLines, SyncEngine, type PassReport, type RunnerStatus, type StateStore, type Transport } from "@bettersync/core";
import { MarkdownView, Notice, Platform, Plugin, PluginSettingTab, requestUrl, setIcon, Setting, TFile, type App, type Editor, type EditorChange, type TAbstractFile } from "obsidian";
import { ObsidianFs, type OpenNote, type VaultApi } from "./obsidian-fs.ts";

/**
 * The BetterSync plugin (design doc, "Obsidian plugin"): a thin layer that
 * runs the shared sync engine on the vault. Settings are the server URL, the
 * token, a device name and a pause toggle; nothing else.
 */

interface Settings {
  server: string;
  token: string;
  device: string;
  paused: boolean;
  /** The server the saved sync state belongs to; another server starts fresh. */
  stateServer: string;
}

const DEFAULTS: Settings = { server: "", token: "", device: "", paused: false, stateServer: "" };

type Status = RunnerStatus | "setup" | "conflict";

const STATUS: Record<Status, { icon: string; label: string }> = {
  setup: { icon: "cloud-cog", label: "BetterSync: enter the server URL and token in settings" },
  idle: { icon: "cloud", label: "BetterSync: starting" },
  syncing: { icon: "refresh-cw", label: "BetterSync: syncing" },
  synced: { icon: "cloud", label: "BetterSync: synced" },
  offline: { icon: "cloud-off", label: "BetterSync: offline, retrying" },
  unauthorized: { icon: "key-round", label: "BetterSync: the server rejected the token" },
  paused: { icon: "pause-circle", label: "BetterSync: paused" },
  conflict: { icon: "alert-triangle", label: "BetterSync: synced; there are conflict copies to resolve" },
};

/** Names the server gives conflict copies: "Note (conflict 2026-09-30 laptop).md". */
const CONFLICT_COPY = / \(conflict \d{4}-\d{2}-\d{2} [^/]+\)\.md$/;

export default class BetterSyncPlugin extends Plugin {
  override settings: Settings = { ...DEFAULTS };
  private runner: Runner | undefined;
  private fs: ObsidianFs | undefined;
  private statusEl!: HTMLElement;
  /** On mobile, which has no status bar, the status shows as a ribbon icon instead. */
  private ribbonEl: HTMLElement | undefined;
  private status: Status = "setup";
  private restartTimer: number | undefined;
  private generation = 0;
  /** Starts and stops run one after another, so a runner is fully stopped before the next one opens the state. */
  private lifecycle: Promise<void> = Promise.resolve();
  private unloaded = false;
  private readonly logLines: string[] = [];

  override async onload(): Promise<void> {
    this.settings = { ...DEFAULTS, ...((await this.loadData()) as Partial<Settings> | null) };
    if (!this.settings.device) {
      this.settings.device = defaultDeviceName();
      await this.saveData(this.settings);
    }
    this.addSettingTab(new BetterSyncSettingTab(this.app, this));

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("mod-clickable", "bettersync-status");
    this.registerDomEvent(this.statusEl, "click", () => this.onStatusClick());
    if (Platform.isMobile) this.ribbonEl = this.addRibbonIcon(STATUS.setup.icon, STATUS.setup.label, () => this.onStatusClick());
    this.render();

    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.runner?.syncNow() });
    this.addCommand({ id: "toggle-pause", name: "Pause or resume syncing", callback: () => void this.setPaused(!this.settings.paused) });
    this.addCommand({ id: "show-status", name: "Show sync status", callback: () => new Notice(STATUS[this.effectiveStatus()].label) });
    this.addCommand({ id: "copy-log", name: "Copy recent sync log", callback: () =>
        void navigator.clipboard.writeText(this.logLines.join("\n")).then(
          () => new Notice("BetterSync: log copied"),
          (e: unknown) => new Notice(`BetterSync: could not copy the log (${e instanceof Error ? e.message : String(e)})`),
        ),
    });

    for (const kind of ["create", "modify", "delete", "rename"] as const) {
      this.registerEvent(this.app.vault.on(kind as "rename", (file: TAbstractFile, oldPath?: string) => this.onVaultEvent(kind, file, oldPath)));
    }
    this.registerEvent(this.app.workspace.on("editor-change", () => this.runner?.localChange()));
    // iOS suspends plugins in the background and a laptop sleeps: catch up on return.
    this.registerDomEvent(document, "visibilitychange", () => document.visibilityState === "visible" && this.runner?.wake());
    this.registerDomEvent(window, "online", () => this.runner?.wake());

    // The vault's file index is complete once the layout is ready; listing it earlier would look like deletes.
    this.app.workspace.onLayoutReady(() => void this.start());
  }

  override onunload(): void {
    window.clearTimeout(this.restartTimer);
    // A start() still awaiting sees this and never creates its runner; a queued one never runs.
    this.unloaded = true;
    this.generation++;
    void this.queue(() => this.stopRunner());
  }

  private queue(step: () => Promise<void>): Promise<void> {
    this.lifecycle = this.lifecycle.then(step, step);
    return this.lifecycle;
  }

  /** The API the tests and a debugging user can reach: app.plugins.plugins.bettersync. */
  get debug() {
    return { status: this.effectiveStatus(), runner: this.runner, log: this.logLines };
  }

  // ---- lifecycle ----

  private start(): Promise<void> {
    return this.queue(() => this.restart());
  }

  private async restart(): Promise<void> {
    if (this.unloaded) return;
    const gen = ++this.generation;
    await this.stopRunner();
    const { server, token, device } = this.settings;
    if (!server || !token) return this.setStatus("setup");
    if (this.settings.stateServer !== server) {
      await this.stateStore().save(""); // unreadable: the engine starts fresh from the server
      this.settings.stateServer = server;
      await this.saveData(this.settings);
    }
    const vault = this.app.vault as unknown as VaultApi;
    const fs = new ObsidianFs(vault, (path) => this.openNotes(path), await this.caseInsensitive());
    const remote = new HttpRemote({ server, token, device, transport: obsidianTransport });
    const engine = await SyncEngine.open({ fs, remote, store: this.stateStore(), device, now: Date.now, log: (m) => this.log(m) });
    if (gen !== this.generation) return;
    this.fs = fs;
    this.runner = new Runner({
      engine,
      live: () => remote.live(),
      log: (m) => this.log(m),
      onStatus: (s) => this.setStatus(s),
      onReport: (r) => this.onReport(r),
      beforePass: () => this.saveOpenEditors(),
    });
    // Nothing awaits from the generation check to here, so an unload cannot slip in between.
    if (this.settings.paused) void this.runner.pause();
    this.runner.start();
    this.log(`syncing with ${server} as ${device}`);
  }

  private async stopRunner(): Promise<void> {
    const r = this.runner;
    this.runner = undefined;
    this.fs = undefined;
    await r?.stop();
  }

  /** Settings changed: reconnect once typing in the settings has stopped. */
  scheduleRestart(): void {
    window.clearTimeout(this.restartTimer);
    this.restartTimer = window.setTimeout(() => void this.start(), 1500);
  }

  async setPaused(paused: boolean): Promise<void> {
    this.settings.paused = paused;
    await this.saveData(this.settings);
    if (paused) await this.runner?.pause();
    else this.runner?.resume();
    this.render();
  }

  // ---- vault ----

  private onVaultEvent(kind: "create" | "modify" | "delete" | "rename", file: TAbstractFile, oldPath?: string): void {
    this.fs?.noteEvent(kind, file as never, oldPath);
    if (isSyncablePath(file.path) || (oldPath !== undefined && isSyncablePath(oldPath)) || !(file instanceof TFile)) this.runner?.localChange();
    if (kind !== "modify") this.render();
  }

  private openNotes(path: string): OpenNote[] {
    const out: OpenNote[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === path) {
        // dirty and lastSavedData are not public API. If they go away, fail safe: an editor whose
        // saved text is unknown counts as holding typing, and its note is not written while open.
        const v = view as MarkdownView & { dirty?: boolean; lastSavedData?: string };
        const savedText = () => (typeof v.lastSavedData === "string" ? v.lastSavedData : null);
        out.push({
          get dirty() {
            const saved = savedText();
            return v.dirty === true || saved === null || saved !== v.getViewData();
          },
          save: () => v.save(),
          text: () => v.getViewData(),
          savedText,
          setText: (text) => replaceText(v.editor, text),
        });
      }
    });
    return out;
  }

  /**
   * Saves editors holding typing, so it goes out now rather than after
   * Obsidian's 2 s autosave. Not a note whose remote change waits on its
   * typing: each early save would push a version the server can only keep as
   * another conflict copy. Obsidian's own autosave ends the wait.
   */
  private async saveOpenEditors(): Promise<void> {
    const saves: Promise<void>[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return;
      if ((view as unknown as { dirty?: boolean }).dirty !== true) {
        // Saved: whatever waited on this editor's typing waits no longer.
        if (view.file) this.fs?.clearBusy(view.file.path);
        return;
      }
      if (view.file && this.fs?.isBusy(view.file.path)) return;
      saves.push(view.save().catch(() => {}));
    });
    await Promise.all(saves);
  }

  private get pluginDir(): string {
    return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }

  private stateStore(): StateStore {
    const path = `${this.pluginDir}/state.json`;
    const adapter = this.app.vault.adapter;
    return {
      load: async () => ((await adapter.exists(path)) ? adapter.read(path) : null),
      save: (json) => adapter.write(path, json),
    };
  }

  /** Probes whether the vault's disk ignores case, by looking up this plugin's manifest in upper case. */
  private async caseInsensitive(): Promise<boolean> {
    const path = `${this.pluginDir}/manifest.json`;
    const upper = path.toUpperCase();
    return upper !== path && (await this.app.vault.adapter.exists(upper));
  }

  // ---- status ----

  private setStatus(s: Status): void {
    const before = this.status;
    this.status = s;
    if (s === "unauthorized" && before !== "unauthorized") new Notice("BetterSync: the server rejected the token. Enter the current one in the plugin settings.", 15_000);
    this.render();
  }

  private conflictCopies(): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((f) => CONFLICT_COPY.test(f.path));
  }

  private effectiveStatus(): Status {
    if (this.settings.paused && this.status !== "setup") return "paused";
    if (this.status === "synced" && this.conflictCopies().length > 0) return "conflict";
    return this.status;
  }

  private render(): void {
    if (!this.statusEl) return;
    const s = this.effectiveStatus();
    this.statusEl.empty();
    setIcon(this.statusEl, STATUS[s].icon);
    this.statusEl.setAttribute("aria-label", STATUS[s].label);
    this.statusEl.setAttribute("data-tooltip-position", "top");
    this.statusEl.dataset.bettersyncStatus = s;
    if (this.ribbonEl) {
      setIcon(this.ribbonEl, STATUS[s].icon);
      this.ribbonEl.setAttribute("aria-label", STATUS[s].label);
      this.ribbonEl.dataset.bettersyncStatus = s;
    }
  }

  private onStatusClick(): void {
    const copies = this.conflictCopies();
    if (this.effectiveStatus() === "conflict" && copies[0]) void this.app.workspace.getLeaf(false).openFile(copies[0]);
    else if (this.status === "setup" || this.status === "unauthorized") openSettings(this.app, this.manifest.id);
    else this.runner?.syncNow();
  }

  private onReport(r: PassReport): void {
    for (const copy of r.conflicts) new Notice(`BetterSync: an edit from this device overlapped another. The other version stays in the note; this device's version is saved as "${copy}".`, 20_000);
    for (const x of r.rejected) new Notice(`BetterSync: the server refused a change: ${x.reason}`, 10_000);
    this.render();
  }

  private log(m: string): void {
    const line = `${new Date().toISOString()} ${m}`;
    this.logLines.push(line);
    if (this.logLines.length > 500) this.logLines.splice(0, this.logLines.length - 500);
    console.debug(`[BetterSync] ${m}`);
  }
}

class BetterSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: BetterSyncPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    const p = this.plugin;
    containerEl.empty();
    const save = async (patch: Partial<Settings>) => {
      Object.assign(p.settings, patch);
      await p.saveData(p.settings);
      p.scheduleRestart();
    };
    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("The address of your BetterSync server, e.g. https://notes.example.com")
      .addText((t) => t.setPlaceholder("https://notes.example.com").setValue(p.settings.server).onChange((v) => save({ server: v.trim().replace(/\/+$/, "") })));
    new Setting(containerEl)
      .setName("Token")
      .setDesc("Printed by the server when it first starts, or by `bettersync rotate-token`.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(p.settings.token).onChange((v) => save({ token: v.trim() }));
      });
    new Setting(containerEl)
      .setName("Device name")
      .setDesc("Shown in history and in the names of conflict copies made from this device's edits.")
      .addText((t) => t.setValue(p.settings.device).onChange((v) => save({ device: v.trim() || defaultDeviceName() })));
    new Setting(containerEl)
      .setName("Pause syncing")
      .addToggle((t) => t.setValue(p.settings.paused).onChange((v) => void p.setPaused(v)));
  }
}

/** Server calls through Obsidian's requestUrl: no CORS, and the same on desktop and iOS. */
const obsidianTransport: Transport = async (req) => {
  const headers = { ...req.headers };
  const contentType = headers["Content-Type"];
  delete headers["Content-Type"];
  const body = req.body === undefined || typeof req.body === "string" ? req.body : (req.body.slice().buffer as ArrayBuffer);
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`${req.method} ${req.url}: timed out`)), req.timeoutMs);
  });
  try {
    const r = await Promise.race([requestUrl({ url: req.url, method: req.method, headers, throw: false, ...(body !== undefined && { body }), ...(contentType !== undefined && { contentType }) }), timeout]);
    return { status: r.status, bytes: async () => new Uint8Array(r.arrayBuffer), text: async () => r.text };
  } finally {
    window.clearTimeout(timer);
  }
};

/**
 * Changes an editor's text to `next` with one transaction of line-level
 * edits, so the cursor and scroll stay where they were unless the lines
 * around them changed.
 */
function replaceText(editor: Editor, next: string): void {
  const cur = editor.getValue();
  if (cur === next) return;
  const oldLines = splitLines(cur);
  const offsets = [0];
  for (const l of oldLines) offsets.push(offsets.at(-1)! + l.length);
  const changes: EditorChange[] = diffLines(oldLines, splitLines(next)).map((h) => ({
    from: editor.offsetToPos(offsets[h.start]!),
    to: editor.offsetToPos(offsets[h.end]!),
    text: h.lines.join(""),
  }));
  editor.transaction({ changes });
}

function defaultDeviceName(): string {
  if (Platform.isDesktopApp) {
    try {
      const os = (window as unknown as { require(m: string): { hostname(): string } }).require("os");
      const name = os.hostname().split(".")[0];
      if (name) return name;
    } catch {
      // fall through
    }
    return Platform.isMacOS ? "mac" : Platform.isWin ? "windows" : "linux";
  }
  if (Platform.isIosApp) return Platform.isTablet ? "ipad" : "iphone";
  return Platform.isAndroidApp ? "android" : "mobile";
}

function openSettings(app: App, id: string): void {
  const setting = (app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
  setting?.open();
  setting?.openTabById(id);
}
