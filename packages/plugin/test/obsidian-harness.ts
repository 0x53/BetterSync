import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

/**
 * Drives a real Obsidian over the Chrome DevTools Protocol, for the
 * end-to-end tests. Obsidian must already be running with a test vault open
 * and `--remote-debugging-port`; OBSIDIAN_CDP is that port's URL
 * (e.g. http://127.0.0.1:9222). Everything happens inside the app, through
 * the same `app` object plugins use: installing the plugin, editing notes,
 * typing into editors and reading the status bar.
 *
 * Never point this at a vault you care about: `reset` deletes every note.
 */

const DIST = join(import.meta.dir, "..", "dist");
export const PLUGIN_ID = "bettersync";

export interface PluginSettings {
  server: string;
  token: string;
  device: string;
  paused?: boolean;
}

export class ObsidianApp {
  private constructor(
    private readonly browser: Browser,
    private page: Page,
  ) {}

  static async connect(cdp: string): Promise<ObsidianApp> {
    const browser = await chromium.connectOverCDP(cdp);
    const app = new ObsidianApp(browser, await findPage(browser));
    await app.waitReady();
    return app;
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  /** Evaluates a function inside Obsidian, where `app` is the global App. */
  eval<T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T> {
    return this.page.evaluate(fn as never, arg as never) as Promise<T>;
  }

  private async waitReady(): Promise<void> {
    await this.page.waitForFunction(() => (globalThis as any).app?.workspace?.layoutReady === true, undefined, { timeout: 30_000 });
  }

  /** Reloads the window: Obsidian starts over, like a quit and relaunch (the plugin's memory is gone). */
  async reload(): Promise<void> {
    await this.page.evaluate(() => location.reload()).catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));
    this.page = await findPage(this.browser);
    await this.waitReady();
  }

  /** Disables the plugin and deletes every note and folder outside hidden folders. */
  async reset(): Promise<void> {
    await this.eval(async (id) => {
      const app = (globalThis as any).app;
      // A rename asks "Update links?" in a modal unless this is set; nobody would answer it.
      app.vault.setConfig("alwaysUpdateLinks", true);
      for (const b of Array.from(document.querySelectorAll(".modal-close-button"))) (b as HTMLElement).click();
      await app.plugins.disablePlugin(id);
      for (const leaf of app.workspace.getLeavesOfType("markdown")) leaf.detach();
      for (const child of [...app.vault.getRoot().children]) await app.vault.delete(child, true);
    }, PLUGIN_ID);
  }

  /** Copies dist/ into the vault, writes settings, forgets sync state, and enables the plugin. */
  async installPlugin(settings: PluginSettings, opts: { keepState?: boolean } = {}): Promise<void> {
    const files = { "main.js": readFileSync(join(DIST, "main.js"), "utf8"), "manifest.json": readFileSync(join(DIST, "manifest.json"), "utf8") };
    await this.eval(
      async ({ id, files, settings, keepState }) => {
        const app = (globalThis as any).app;
        const dir = `${app.vault.configDir}/plugins/${id}`;
        await app.plugins.disablePlugin(id);
        if (!(await app.vault.adapter.exists(dir))) await app.vault.adapter.mkdir(dir);
        for (const [name, text] of Object.entries(files)) await app.vault.adapter.write(`${dir}/${name}`, text);
        await app.vault.adapter.write(`${dir}/data.json`, JSON.stringify({ paused: false, stateServer: settings.server, ...settings }));
        if (!keepState && (await app.vault.adapter.exists(`${dir}/state.json`))) await app.vault.adapter.remove(`${dir}/state.json`);
        if (!app.plugins.isEnabled?.() && app.plugins.setEnable) await app.plugins.setEnable(true);
        await app.plugins.loadManifests();
        await app.plugins.enablePluginAndSave(id);
      },
      { id: PLUGIN_ID, files, settings, keepState: opts.keepState ?? false },
    );
    await this.page.waitForFunction((id) => !!(globalThis as any).app.plugins.plugins[id]?.debug, PLUGIN_ID);
  }

  async disablePlugin(): Promise<void> {
    await this.eval((id) => (globalThis as any).app.plugins.disablePlugin(id), PLUGIN_ID);
  }

  async enablePlugin(): Promise<void> {
    await this.eval((id) => (globalThis as any).app.plugins.enablePlugin(id), PLUGIN_ID);
  }

  /** The status the status bar shows (synced, syncing, offline, paused, conflict, ...). */
  status(): Promise<string | undefined> {
    return this.eval(() => (document.querySelector(".bettersync-status") as HTMLElement | null)?.dataset.bettersyncStatus);
  }

  /** The plugin's recent log. */
  log(): Promise<string[]> {
    return this.eval((id) => [...((globalThis as any).app.plugins.plugins[id]?.debug?.log ?? [])], PLUGIN_ID);
  }

  /** Notices on screen right now. */
  notices(): Promise<string[]> {
    return this.eval(() => Array.from(document.querySelectorAll(".notice"), (n) => n.textContent ?? ""));
  }

  /** Every note in the vault index: path → text. */
  notes(): Promise<Map<string, string>> {
    return this.eval(async () => {
      const app = (globalThis as any).app;
      const out: [string, string][] = [];
      for (const f of app.vault.getMarkdownFiles()) out.push([f.path, await app.vault.read(f)]);
      return out;
    }).then((e) => new Map(e));
  }

  /** Creates or replaces a note through the vault API, as Obsidian itself would. */
  write(path: string, text: string): Promise<void> {
    return this.eval(
      async ({ path, text }) => {
        const app = (globalThis as any).app;
        const f = app.vault.getAbstractFileByPath(path);
        if (f) return app.vault.modify(f, text);
        const dir = path.split("/").slice(0, -1).join("/");
        if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
        await app.vault.create(path, text);
      },
      { path, text },
    );
  }

  /** Renames or moves a note the way the file explorer does, updating links to it. */
  rename(from: string, to: string): Promise<void> {
    return this.eval(
      async ({ from, to }) => {
        const app = (globalThis as any).app;
        const dir = to.split("/").slice(0, -1).join("/");
        if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
        await app.fileManager.renameFile(app.vault.getAbstractFileByPath(from), to);
      },
      { from, to },
    );
  }

  remove(path: string): Promise<void> {
    return this.eval((path) => (globalThis as any).app.vault.delete((globalThis as any).app.vault.getAbstractFileByPath(path), true), path);
  }

  /** Opens a note in the active tab. */
  open(path: string): Promise<void> {
    return this.eval(async (path) => {
      const app = (globalThis as any).app;
      await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath(path));
    }, path);
  }

  /** Types into the active editor at the end of line `line` (0-based), as keystrokes would. Leaves it unsaved. */
  typeAt(line: number, text: string): Promise<void> {
    return this.eval(
      ({ line, text }) => {
        const ed = (globalThis as any).app.workspace.activeEditor.editor;
        ed.replaceRange(text, { line, ch: ed.getLine(line).length });
      },
      { line, text },
    );
  }

  /** Replaces a whole line of the active editor, unsaved. */
  replaceLine(line: number, text: string): Promise<void> {
    return this.eval(
      ({ line, text }) => {
        const ed = (globalThis as any).app.workspace.activeEditor.editor;
        ed.replaceRange(text, { line, ch: 0 }, { line, ch: ed.getLine(line).length });
      },
      { line, text },
    );
  }

  editorText(): Promise<string | undefined> {
    return this.eval(() => (globalThis as any).app.workspace.activeEditor?.editor?.getValue());
  }

  editorDirty(): Promise<boolean> {
    return this.eval(() => (globalThis as any).app.workspace.activeEditor?.dirty === true);
  }

  screenshot(path: string): Promise<Buffer> {
    return this.page.screenshot({ path });
  }
}

async function findPage(browser: Browser): Promise<Page> {
  for (let i = 0; i < 100; i++) {
    for (const ctx of browser.contexts()) {
      const page = ctx.pages().find((p) => p.url().startsWith("app://"));
      if (page) return page;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("no Obsidian window found over CDP");
}
