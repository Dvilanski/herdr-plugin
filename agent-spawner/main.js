import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
  theme,
  spaces,
  panes,
  machines,
  focused,
  knownAgents,
  run,
  closeOverlay,
  props,
  shared,
  setShared,
  pickFolder,
  notify,
  exec,
  hc,
  home,
} from "herdr";

const HISTORY_KEY = "agent-spawner.history";
const LAST_AGENT_KEY = "agent-spawner.last-agent";
const LAST_TARGET_KEY = "agent-spawner.last-target";
const LAST_MACHINE_KEY = "agent-spawner.last-machine";
const AGENTS_CACHE_KEY = "agent-spawner.agents-cache";
const USE_DOCKER_KEY = "agent-spawner.use-docker";
const DOCKER_IMAGE_KEY = "agent-spawner.docker-image";
const DOCKER_CERTS_KEY = "agent-spawner.docker-certs";
const DOCKER_BIN_MODE_KEY = "agent-spawner.docker-bin-mode";
const GIT_NAME_KEY = "agent-spawner.git-name";
const GIT_EMAIL_KEY = "agent-spawner.git-email";

const DEFAULT_AGENTS = [
  { key: "antigravity", name: "Antigravity", icon: "icons/antigravity.svg", run: ["agy"], installed: true },
  { key: "claude", name: "Claude Code", icon: "icons/claude.svg", run: ["claude"], installed: false },
  { key: "codex", name: "Codex", icon: "icons/codex.svg", run: ["codex"], installed: false },
  { key: "cursor", name: "Cursor", icon: "icons/cursor.svg", run: ["cursor-agent"], installed: false },
  { key: "gemini", name: "Gemini", icon: "icons/gemini.svg", run: ["gemini"], installed: false },
  { key: "copilot", name: "Copilot", icon: "icons/copilot.svg", run: ["copilot"], installed: false },
];

const PRESET_PROMPTS = [
  { label: "🐛 Fix Bug", text: "Diagnose and fix the issue reported in the logs or tests." },
  { label: "🧪 Add Tests", text: "Write comprehensive unit tests covering the core logic." },
  { label: "🔍 Code Review", text: "Review uncommitted git changes and suggest improvements." },
  { label: "⚡ Refactor", text: "Refactor this code for readability, performance, and best practices." },
  { label: "📖 Explain", text: "Explain the architecture, structure, and data flow of this project." },
];

const DEFAULT_DOCKER_IMAGES = ["herdr-agent:latest", "ubuntu:latest", "node:20", "python:3.12"];

function prepareAgentArgv(agent, task) {
  const baseRun = [...agent.run];
  if (!task) return baseRun;

  const prog = baseRun[0]?.toLowerCase() || "";
  const key = agent.key?.toLowerCase() || "";

  // Antigravity CLI requires -i / --prompt-interactive for initial prompt in interactive mode
  if (prog === "agy" || key === "antigravity") {
    if (
      baseRun.includes("-i") ||
      baseRun.includes("-p") ||
      baseRun.includes("--prompt-interactive") ||
      baseRun.includes("--print")
    ) {
      return [...baseRun, task];
    }
    return [...baseRun, "-i", task];
  }

  // Aider CLI uses --message
  if (prog === "aider" || key === "aider") {
    if (baseRun.includes("-m") || baseRun.includes("--message")) {
      return [...baseRun, task];
    }
    return [...baseRun, "--message", task];
  }

  // Default: positional prompt argument (Claude Code, Codex, Gemini, etc.)
  return [...baseRun, task];
}

export default class AgentSpawner extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();

    const activeSpace = spaces().find((s) => s.active);
    const activePane = panes().find((p) => p.focused);
    const currentMachine = activeSpace?.machine ?? null;

    // Target machine: restore last machine or active space's machine
    const savedMachine = shared(LAST_MACHINE_KEY);
    this.selectedMachine = savedMachine !== undefined ? savedMachine : (currentMachine ?? (machines()?.find((m) => m.name)?.name ?? null));
    this.remoteConnectedMachines = [];

    // Directory tree navigation state
    this.showTree = Boolean(this.selectedMachine);
    this.treeShowHidden = false;
    this.treeRoot = null;
    this.machineHome = home();

    // Working directory default: space folder or home on that machine
    if (this.selectedMachine) {
      const remSpace = spaces().find((s) => s.machine === this.selectedMachine);
      this.cwd = remSpace?.folder || "~";
    } else {
      this.cwd = focused()?.cwd ?? activePane?.cwd ?? activeSpace?.folder ?? home();
    }

    this.cwdInput = InputState.new({
      value: this.cwd,
      placeholder: "e.g. /home/user/project or ~",
    });
    this.cwdInput.on("change", (_e, cx) => {
      this.cwd = this.cwdInput.value();
      cx.notify();
    });

    // Initialize machine home and tree
    cx.spawn(async (cx) => {
      try {
        if (this.selectedMachine) {
          this.machineHome = await this.fetchMachineHome(this.selectedMachine);
          if (this.cwd === "~") {
            this.cwd = this.machineHome;
            this.cwdInput.set_value(this.cwd);
          }
        } else {
          this.machineHome = home();
        }
        await this.initTreeForCurrentMachine(cx);
      } catch {
        // ignore
      }
    });

    this.target = shared(LAST_TARGET_KEY) ?? "tab"; // "tab" | "split-right" | "split-down" | "space"
    this.selectedAgentKey = shared(LAST_AGENT_KEY) ?? "antigravity";
    this.useCustomCommand = false;
    this.customCommand = "";

    // Docker container isolation settings
    this.useDocker = shared(USE_DOCKER_KEY) ?? false;
    this.dockerImage = shared(DOCKER_IMAGE_KEY) ?? "herdr-agent:latest";
    this.dockerMountCerts = shared(DOCKER_CERTS_KEY) ?? true;
    this.binaryMode = shared(DOCKER_BIN_MODE_KEY) ?? "image"; // "image" | "mount" | "install"
    this.gitName = shared(GIT_NAME_KEY) ?? "";
    this.gitEmail = shared(GIT_EMAIL_KEY) ?? "";
    this.apiKey = "";
    this.dockerExtraFlags = "";
    this.localDockerImages = [];
    this.isBuildingImage = false;
    this.uid = "1000";
    this.gid = "1000";

    this.dockerImageInput = InputState.new({
      value: this.dockerImage,
      placeholder: "e.g. herdr-agent:latest, ubuntu:latest, node:20",
    });
    this.dockerImageInput.on("change", (_e, cx) => {
      this.dockerImage = this.dockerImageInput.value();
      cx.notify();
    });

    this.gitNameInput = InputState.new({
      value: this.gitName,
      placeholder: "e.g. Ben",
    });
    this.gitNameInput.on("change", (_e, cx) => {
      this.gitName = this.gitNameInput.value();
      cx.notify();
    });

    this.gitEmailInput = InputState.new({
      value: this.gitEmail,
      placeholder: "e.g. ben@example.com",
    });
    this.gitEmailInput.on("change", (_e, cx) => {
      this.gitEmail = this.gitEmailInput.value();
      cx.notify();
    });

    this.apiKeyInput = InputState.new({
      placeholder: "e.g. GEMINI_API_KEY, ANTHROPIC_API_KEY...",
    });
    this.apiKeyInput.on("change", (_e, cx) => {
      this.apiKey = this.apiKeyInput.value();
      cx.notify();
    });

    this.dockerExtraInput = InputState.new({
      placeholder: "Extra flags (e.g. -p 8080:8080 --network bridge)",
    });
    this.dockerExtraInput.on("change", (_e, cx) => {
      this.dockerExtraFlags = this.dockerExtraInput.value();
      cx.notify();
    });

    this.history = (shared(HISTORY_KEY) ?? []).slice(0, 5);

    this.taskText = "";
    this.taskInput = InputState.new({ placeholder: "What should the agent do? (Optional prompt / task)" });
    this.taskInput.on("change", (_e, cx) => {
      this.taskText = this.taskInput.value();
      cx.notify();
    });
    this.taskInput.on("submit", () => {
      this.spawn();
    });

    this.customInput = InputState.new({ placeholder: "e.g. claude --dangerously-skip-permissions" });
    this.customInput.on("change", (_e, cx) => {
      this.customCommand = this.customInput.value();
      cx.notify();
    });

    // Warm-start with cached agents if available, otherwise DEFAULT_AGENTS
    const where = this.selectedMachine ?? "";
    const cached = shared(AGENTS_CACHE_KEY)?.[where] ?? shared("new-menu.agents")?.[where] ?? shared("new-menu.agents")?.[""];
    const list = cached && cached.length ? cached : DEFAULT_AGENTS;
    this.agents = [...list].sort((a, b) => (b.installed ? 1 : 0) - (a.installed ? 1 : 0));
    this.loadingAgents = false;

    this.ensureValidSelectedAgent();

    // Discover host UID/GID
    cx.spawn(async () => {
      try {
        const u = await exec("id", ["-u"]);
        const g = await exec("id", ["-g"]);
        if (u?.stdout?.trim()) this.uid = u.stdout.trim();
        if (g?.stdout?.trim()) this.gid = g.stdout.trim();
      } catch {
        // default 1000:1000
      }
    });

    // Try prefilling host git name/email if not saved in shared
    if (!this.gitName || !this.gitEmail) {
      cx.spawn(async (cx) => {
        try {
          if (!this.gitName) {
            const n = await exec("git", ["config", "user.name"]);
            if (n?.stdout?.trim()) {
              this.gitName = n.stdout.trim();
              this.gitNameInput.set_value(this.gitName);
            }
          }
          if (!this.gitEmail) {
            const e = await exec("git", ["config", "user.email"]);
            if (e?.stdout?.trim()) {
              this.gitEmail = e.stdout.trim();
              this.gitEmailInput.set_value(this.gitEmail);
            }
          }
          cx.notify();
        } catch {
          // ignore
        }
      });
    }

    // Load updated known agents for selected machine in background
    cx.spawn(async (cx) => {
      try {
        this.loadingAgents = true;
        const probed = await knownAgents({ on: this.selectedMachine });
        if (probed && probed.length) {
          this.agents = probed.sort((a, b) => (b.installed ? 1 : 0) - (a.installed ? 1 : 0));
          const allCache = shared(AGENTS_CACHE_KEY) ?? {};
          setShared(AGENTS_CACHE_KEY, { ...allCache, [where]: this.agents });
          this.ensureValidSelectedAgent();
        }
      } catch {
        // keep current agents
      } finally {
        this.loadingAgents = false;
        cx.notify();
      }
    });

    // Discover connected remote machines via hc machine ls
    cx.spawn(async (cx) => {
      try {
        const res = await exec("hc", ["machine", "ls"]);
        const lines = (res?.stdout ?? "").split("\n");
        const remotes = [];
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2 && parts[1] === "connected" && parts[0]) {
            remotes.push(parts[0]);
          }
        }
        this.remoteConnectedMachines = remotes;
        cx.notify();
      } catch {
        // ignore
      }
    });

    // Discover local docker images
    cx.spawn(async (cx) => {
      try {
        const res = await exec("docker", ["images", "--format", "{{.Repository}}:{{.Tag}}"]);
        const lines = (res?.stdout ?? "")
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s && !s.includes("<none>") && !s.startsWith("curlimages/") && !s.startsWith("nats:"));
        this.localDockerImages = Array.from(new Set(lines)).slice(0, 8);
        if (this.localDockerImages.includes("herdr-agent:latest") && !shared(DOCKER_IMAGE_KEY)) {
          this.setDockerImage("herdr-agent:latest");
        }
        cx.notify();
      } catch {
        this.localDockerImages = [];
      }
    });
  }

  buildAgentImage(cx) {
    if (this.isBuildingImage) return;
    this.isBuildingImage = true;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const h = home();
        const dockerDir = "/home/ben/Documents/projects/herdr-plugins/agent-spawner/docker";
        await exec("cp", [`${h}/.local/bin/agy`, `${dockerDir}/agy`]);
        const res = await exec("docker", ["build", "-t", "herdr-agent:latest", dockerDir]);
        if (res.code === 0) {
          this.setDockerImage("herdr-agent:latest");
          this.binaryMode = "image";
          if (!this.localDockerImages.includes("herdr-agent:latest")) {
            this.localDockerImages = ["herdr-agent:latest", ...this.localDockerImages];
          }
          notify({ title: "Image Ready", body: "herdr-agent:latest built successfully!" });
        } else {
          notify({ title: "Build Failed", body: res.stderr || "Could not build docker image", level: "error" });
        }
      } catch (err) {
        notify({ title: "Build Error", body: String(err), level: "error" });
      } finally {
        this.isBuildingImage = false;
        cx.notify();
      }
    });
  }

  setPreset(text) {
    this.taskText = text;
    this.taskInput.set_value(text);
  }

  setDockerImage(img) {
    this.dockerImage = img;
    this.dockerImageInput.set_value(img);
  }

  async browseFolder(cx) {
    const picked = await pickFolder({ prompt: "Select Project Directory" });
    if (picked) {
      this.cwd = picked;
      this.cwdInput.set_value(picked);
      cx.notify();
    }
  }

  ensureValidSelectedAgent() {
    const hasSelected = this.agents.some((a) => a.key === this.selectedAgentKey);
    if (!hasSelected || (!this.agents.find((a) => a.key === this.selectedAgentKey)?.installed && this.agents.some((a) => a.installed))) {
      const firstInstalled = this.agents.find((a) => a.installed);
      if (firstInstalled) {
        this.selectedAgentKey = firstInstalled.key;
      }
    }
  }

  getAllMachines() {
    const list = [{ name: null, label: "💻 Local Host" }];
    const seen = new Set([null, ""]);

    // Add from herdr machines()
    try {
      const herdrMachines = machines();
      if (Array.isArray(herdrMachines)) {
        for (const m of herdrMachines) {
          if (m && m.name && !seen.has(m.name)) {
            seen.add(m.name);
            list.push({
              name: m.name,
              label: this.getMachineDisplayName(m.name),
            });
          }
        }
      }
    } catch {
      // fallback
    }

    // Add from spaces()
    try {
      for (const s of spaces()) {
        if (s.machine && !seen.has(s.machine)) {
          seen.add(s.machine);
          list.push({
            name: s.machine,
            label: this.getMachineDisplayName(s.machine),
          });
        }
      }
    } catch {
      // fallback
    }

    // Add from hc machine ls
    for (const rem of this.remoteConnectedMachines) {
      if (rem && !seen.has(rem)) {
        seen.add(rem);
        list.push({
          name: rem,
          label: this.getMachineDisplayName(rem),
        });
      }
    }

    return list;
  }

  getMachineDisplayName(name) {
    if (!name) return "💻 Local Host";
    const sp = spaces().find((s) => s.machine === name);
    if (sp && sp.name) {
      return `🖥️ ${name} (${sp.name})`;
    }
    return `🖥️ ${name}`;
  }

  async runRemoteCommand(machine, cmd, args = []) {
    if (!machine) {
      return await exec(cmd, args);
    }
    try {
      const res = await hc(["exec", "--on", machine, cmd, ...args]);
      if (res && res.code === 0) return res;
    } catch {}
    return await exec(cmd, args, { on: machine });
  }

  async fetchMachineHome(machine) {
    if (!machine) return home();
    try {
      const res = await this.runRemoteCommand(machine, "pwd");
      const h = res?.stdout?.trim();
      if (h && h.startsWith("/")) return h;
    } catch {}
    return "/home/ben";
  }

  async initTreeForCurrentMachine(cx) {
    const startRoot = this.machineHome || "/home/ben";
    this.treeRoot = {
      path: startRoot,
      name: startRoot === "/" ? "/ (Root)" : `~ (${startRoot.split("/").pop() || startRoot})`,
      expanded: true,
      loading: false,
      loaded: false,
      children: [],
    };
    if (cx) {
      cx.notify();
      await this.loadTreeNodeChildren(this.treeRoot, cx);
    }
  }

  async loadTreeNodeChildren(node, cx) {
    if (!node || node.loading) return;
    node.loading = true;
    if (cx) cx.notify();

    const machine = this.selectedMachine;
    let targetDir = node.path;
    if (targetDir === "~") {
      targetDir = this.machineHome || "/home/ben";
    }

    try {
      const res = await this.runRemoteCommand(machine, "find", [
        targetDir,
        "-maxdepth",
        "1",
        "-mindepth",
        "1",
        "-type",
        "d",
      ]);
      const output = res?.stdout || "";
      const lines = output.split("\n").map((s) => s.trim()).filter(Boolean);
      const children = [];

      for (const line of lines) {
        const clean = line.replace(/\/+$/, "");
        const parts = clean.split("/");
        const baseName = parts[parts.length - 1] || clean;
        if (!this.treeShowHidden && baseName.startsWith(".")) {
          continue;
        }
        children.push({
          path: clean,
          name: baseName,
          expanded: false,
          loading: false,
          loaded: false,
          children: [],
        });
      }

      children.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      node.children = children;
      node.loaded = true;
      node.error = null;
    } catch (err) {
      node.error = String(err);
      node.children = [];
    } finally {
      node.loading = false;
      if (cx) cx.notify();
    }
  }

  toggleTreeNode(node, cx) {
    if (!node) return;
    node.expanded = !node.expanded;
    if (node.expanded && !node.loaded) {
      cx.spawn(async (cx) => {
        await this.loadTreeNodeChildren(node, cx);
      });
    } else {
      cx.notify();
    }
  }

  selectDirectory(path, cx) {
    if (!path) return;
    this.cwd = path;
    this.cwdInput.set_value(path);
    cx.notify();
  }

  navigateTreeRoot(newRootPath, cx) {
    this.treeRoot = {
      path: newRootPath,
      name: newRootPath === "/" ? "/ (Root)" : newRootPath.split("/").pop() || newRootPath,
      expanded: true,
      loading: false,
      loaded: false,
      children: [],
    };
    this.selectDirectory(newRootPath, cx);
    cx.spawn(async (cx) => {
      await this.loadTreeNodeChildren(this.treeRoot, cx);
    });
  }

  navigateParentDirectory(cx) {
    let current = this.cwd || this.machineHome || "/";
    current = current.replace(/\/+$/, "");
    const parts = current.split("/").filter(Boolean);
    if (parts.length <= 1) {
      this.navigateTreeRoot("/", cx);
    } else {
      parts.pop();
      const parent = "/" + parts.join("/");
      this.navigateTreeRoot(parent, cx);
    }
  }

  renderTreeNode(node, depth = 0) {
    if (!node) return div();
    const t = theme();
    const isSelected = this.cwd === node.path;
    const isRoot = depth === 0;

    return v_flex()
      .id(`tree-node-${node.path.replace(/[^a-zA-Z0-9_-]/g, "_")}`)
      .child(
        h_flex()
          .pl(6 + depth * 14)
          .pr(6)
          .py(3)
          .h(26)
          .gap(6)
          .items_center()
          .rounded(5)
          .cursor_pointer()
          .bg(isSelected ? t.selected : "#00000000")
          .border_1()
          .border_color(isSelected ? t.accent : "#00000000")
          .hover((s) => s.bg(isSelected ? t.selected : t.hover))
          .on_click((_e, cx) => {
            if (this.cwd === node.path) {
              this.toggleTreeNode(node, cx);
            } else {
              this.selectDirectory(node.path, cx);
              if (!node.expanded) {
                this.toggleTreeNode(node, cx);
              }
            }
          })
          // Chevron
          .child(
            h_flex()
              .size(16)
              .items_center()
              .justify_center()
              .cursor_pointer()
              .hover((s) => s.bg(t.raised))
              .rounded(3)
              .on_click((e, cx) => {
                e.stop_propagation();
                this.toggleTreeNode(node, cx);
              })
              .child(
                div()
                  .text_size(9)
                  .font_bold()
                  .text_color(isSelected ? t.accent : t.dim)
                  .child(node.loading ? "⏳" : node.expanded ? "▼" : "▶")
              )
          )
          // Folder Icon
          .child(div().text_size(12).child(isRoot ? "🏠" : node.expanded ? "📂" : "📁"))
          // Folder Name
          .child(
            div()
              .truncate()
              .text_size(11.5)
              .font_medium()
              .text_color(isSelected ? t.accent : t.foreground)
              .child(node.name)
          )
          .when(node.loading, (el) =>
            el.child(div().text_size(10).text_color(t.dim).child("loading..."))
          )
      )
      .when(node.expanded && node.children && node.children.length > 0, (el) =>
        el.children(node.children.map((child) => this.renderTreeNode(child, depth + 1)))
      )
      .when(node.expanded && node.loaded && (!node.children || node.children.length === 0), (el) =>
        el.child(
          h_flex()
            .pl(6 + (depth + 1) * 14)
            .py(2)
            .child(div().text_size(10.5).text_color(t.dim).child("(Empty folder)"))
        )
      )
      .when(Boolean(node.error), (el) =>
        el.child(
          h_flex()
            .pl(6 + (depth + 1) * 14)
            .py(2)
            .child(div().text_size(10.5).text_color(t.working).child(`(Access restricted)`))
        )
      );
  }

  renderDirectoryTree() {
    const t = theme();
    const hostLabel = this.selectedMachine || "Local Host";

    // Build clickable breadcrumb segments
    const cleanPath = (this.cwd || "/").replace(/\/+$/, "");
    const segments = cleanPath.split("/").filter(Boolean);
    let accum = "";
    const breadcrumbs = [
      { name: "Root", path: "/" },
      ...segments.map((seg) => {
        accum += "/" + seg;
        return { name: seg, path: accum };
      }),
    ];

    return v_flex()
      .id("directory-tree-container")
      .gap(6)
      .p(8)
      .rounded(8)
      .border_1()
      .border_color(t.accent)
      .bg(t.surface)
      // Toolbar / Breadcrumbs Bar
      .child(
        h_flex()
          .justify_between()
          .items_center()
          .gap(6)
          // Breadcrumbs
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .items_center()
              .gap(4)
              .child(div().text_size(11).font_bold().text_color(t.accent).child(`🖥️ ${hostLabel}:`))
              .child(
                h_flex()
                  .flex_wrap()
                  .gap(2)
                  .items_center()
                  .children(
                    breadcrumbs.map((b, idx) =>
                      h_flex()
                        .gap(2)
                        .items_center()
                        .child(
                          h_flex()
                            .id(`crumb-${idx}`)
                            .px(4)
                            .py(1)
                            .rounded(4)
                            .cursor_pointer()
                            .bg(this.cwd === b.path ? t.selected : t.raised)
                            .hover((s) => s.bg(t.hover))
                            .on_click((_e, cx) => {
                              this.navigateTreeRoot(b.path, cx);
                            })
                            .child(
                              div()
                                .text_size(10.5)
                                .text_color(this.cwd === b.path ? t.accent : t.foreground)
                                .child(b.name)
                            )
                        )
                        .when(idx < breadcrumbs.length - 1, (el) =>
                          el.child(div().text_size(9).text_color(t.dim).child("›"))
                        )
                    )
                  )
              )
          )
          // Tree Action Toolbar
          .child(
            h_flex()
              .gap(4)
              .items_center()
              // Home Button
              .child(
                h_flex()
                  .id("btn-tree-home")
                  .px(6)
                  .py(2)
                  .rounded(4)
                  .bg(t.background)
                  .border_1()
                  .border_color(t.border)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => {
                    this.navigateTreeRoot(this.machineHome || "/", cx);
                  })
                  .child(div().text_size(10.5).text_color(t.foreground).child("🏠 Home"))
              )
              // Up / Parent Button
              .child(
                h_flex()
                  .id("btn-tree-up")
                  .px(6)
                  .py(2)
                  .rounded(4)
                  .bg(t.background)
                  .border_1()
                  .border_color(t.border)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => {
                    this.navigateParentDirectory(cx);
                  })
                  .child(div().text_size(10.5).text_color(t.foreground).child("⬆ Up"))
              )
              // Show/Hide Dotfiles
              .child(
                h_flex()
                  .id("btn-tree-hidden")
                  .px(6)
                  .py(2)
                  .rounded(4)
                  .bg(this.treeShowHidden ? t.selected : t.background)
                  .border_1()
                  .border_color(this.treeShowHidden ? t.accent : t.border)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => {
                    this.treeShowHidden = !this.treeShowHidden;
                    if (this.treeRoot) {
                      cx.spawn(async (cx) => {
                        await this.loadTreeNodeChildren(this.treeRoot, cx);
                      });
                    }
                  })
                  .child(
                    div()
                      .text_size(10.5)
                      .text_color(this.treeShowHidden ? t.accent : t.muted)
                      .child(this.treeShowHidden ? "👁️ Hidden: ON" : "👁️ Hidden: OFF")
                  )
              )
              // Refresh Button
              .child(
                h_flex()
                  .id("btn-tree-refresh")
                  .px(6)
                  .py(2)
                  .rounded(4)
                  .bg(t.background)
                  .border_1()
                  .border_color(t.border)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => {
                    if (this.treeRoot) {
                      cx.spawn(async (cx) => {
                        await this.loadTreeNodeChildren(this.treeRoot, cx);
                      });
                    }
                  })
                  .child(div().text_size(10.5).text_color(t.foreground).child("🔄"))
              )
          )
      )
      // Tree List Scrollable View
      .child(
        v_flex()
          .id("tree-items-scroll")
          .h(160)
          .min_h(100)
          .overflow_y_scrollbar()
          .p(4)
          .rounded(6)
          .bg(t.background)
          .border_1()
          .border_color(t.border)
          .when(Boolean(this.treeRoot), (el) => el.child(this.renderTreeNode(this.treeRoot, 0)))
          .when(!this.treeRoot, (el) =>
            el.child(
              h_flex()
                .p(10)
                .items_center()
                .justify_center()
                .child(div().text_size(11).text_color(t.dim).child("Loading directory tree..."))
            )
          )
      );
  }

  selectMachine(name, cx) {
    if (this.selectedMachine === name) return;
    this.selectedMachine = name;
    setShared(LAST_MACHINE_KEY, this.selectedMachine);

    // Update working directory default for this machine
    if (this.selectedMachine) {
      const remSpace = spaces().find((s) => s.machine === this.selectedMachine);
      this.showTree = true;
      this.cwd = remSpace?.folder || "~";
    } else {
      const activeSpace = spaces().find((s) => s.active && !s.machine);
      const activePane = panes().find((p) => p.focused);
      this.cwd = focused()?.cwd ?? activePane?.cwd ?? activeSpace?.folder ?? home();
      this.machineHome = home();
    }
    this.cwdInput.set_value(this.cwd);

    // Initialize directory tree for this machine
    cx.spawn(async (cx) => {
      try {
        if (this.selectedMachine) {
          this.machineHome = await this.fetchMachineHome(this.selectedMachine);
          if (this.cwd === "~") {
            this.cwd = this.machineHome;
            this.cwdInput.set_value(this.cwd);
          }
        }
        await this.initTreeForCurrentMachine(cx);
      } catch {
        // ignore
      }
    });

    // Load cached agents immediately
    const where = this.selectedMachine ?? "";
    const cached = shared(AGENTS_CACHE_KEY)?.[where] ?? shared("new-menu.agents")?.[where];
    if (cached && cached.length) {
      this.agents = [...cached].sort((a, b) => (b.installed ? 1 : 0) - (a.installed ? 1 : 0));
    } else {
      this.agents = [...DEFAULT_AGENTS];
    }
    this.ensureValidSelectedAgent();

    this.loadingAgents = true;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const probed = await knownAgents({ on: this.selectedMachine });
        if (probed && probed.length) {
          this.agents = probed.sort((a, b) => (b.installed ? 1 : 0) - (a.installed ? 1 : 0));
          const allCache = shared(AGENTS_CACHE_KEY) ?? {};
          setShared(AGENTS_CACHE_KEY, { ...allCache, [where]: this.agents });
          this.ensureValidSelectedAgent();
        }
      } catch {
        // ignore
      } finally {
        this.loadingAgents = false;
        cx.notify();
      }
    });
  }

  renderMachineButton(m) {
    const t = theme();
    const isSelected = (this.selectedMachine ?? null) === (m.name ?? null);

    return h_flex()
      .id(`machine-${m.name || "local"}`)
      .px(10)
      .h(32)
      .gap(6)
      .items_center()
      .justify_center()
      .rounded(7)
      .cursor_pointer()
      .border_1()
      .border_color(isSelected ? t.accent : t.border)
      .bg(isSelected ? t.selected : t.surface)
      .text_color(isSelected ? t.accent : t.foreground)
      .text_size(12)
      .font_medium()
      .hover((s) => s.bg(isSelected ? t.selected : t.hover))
      .on_click((_e, cx) => {
        this.selectMachine(m.name, cx);
      })
      .child(div().child(m.label));
  }

  getSelectedAgent() {
    if (this.useCustomCommand) {
      const trimmed = this.customCommand.trim();
      const parts = trimmed ? trimmed.split(/\s+/) : ["bash"];
      return {
        key: "custom",
        name: parts[0] || "Custom",
        run: parts,
        icon: "icons/agent.svg",
        installed: true,
      };
    }
    return this.agents.find((a) => a.key === this.selectedAgentKey) || this.agents[0] || DEFAULT_AGENTS[0];
  }

  spawn() {
    const agent = this.getSelectedAgent();
    if (!agent) return;

    const task = this.taskText.trim() || undefined;
    let finalArgv = prepareAgentArgv(agent, task);
    const activeSpace = spaces().find((s) => s.active);
    const activePane = panes().find((p) => p.focused);
    const currentMachine = activeSpace?.machine ?? null;
    const targetMachine = this.selectedMachine ?? null;
    const isSameMachine = currentMachine === targetMachine;

    // If Docker mode is enabled, wrap inside `docker run` with full isolation
    if (this.useDocker) {
      const selectedImage = this.dockerImage.trim() || "herdr-agent:latest";
      const userSpec = `${this.uid}:${this.gid}`;
      const spaceName = activeSpace?.name || this.cwd.split("/").pop() || "workspace";
      const cleanSpace = spaceName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").replace(/^-+|-+$/g, "") || "space";
      const cleanAgent = (agent.key || agent.name || "agent").toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
      const shortSuffix = Math.random().toString(36).slice(2, 6);
      const containerName = `herdr-agent-${cleanSpace}-${cleanAgent}-${shortSuffix}`;

      const dockerCmd = [
        "docker", "run", "-it", "--rm",
        "--name", containerName,
        "--label", "herdr.agent=true",
        "--label", `herdr.space=${cleanSpace}`,
        "--user", userSpec,
        "-e", "HOME=/tmp",
        "-v", `${this.cwd}:/workspace`,
        "-w", "/workspace",
      ];

      // Option A: Mount host agent binary read-only (only when targeting local machine)
      if (this.binaryMode === "mount" && !targetMachine) {
        const h = home();
        const prog = agent.run[0]?.toLowerCase() || "";
        const key = agent.key?.toLowerCase() || "";
        if (prog === "agy" || key === "antigravity") {
          dockerCmd.push("-v", `${h}/.local/bin/agy:/usr/local/bin/agy:ro`);
        }
      }

      // Host certificates (optional read-only mount)
      if (this.dockerMountCerts) {
        dockerCmd.push("-v", "/etc/ssl/certs:/etc/ssl/certs:ro");
      }

      // Git integration
      if (this.gitName.trim()) {
        dockerCmd.push("-e", `GIT_AUTHOR_NAME=${this.gitName.trim()}`);
        dockerCmd.push("-e", `GIT_COMMITTER_NAME=${this.gitName.trim()}`);
      }
      if (this.gitEmail.trim()) {
        dockerCmd.push("-e", `GIT_AUTHOR_EMAIL=${this.gitEmail.trim()}`);
        dockerCmd.push("-e", `GIT_COMMITTER_EMAIL=${this.gitEmail.trim()}`);
      }

      // API Key / Auth integration (isolated environment variables)
      const keyVal = this.apiKey.trim();
      if (keyVal) {
        dockerCmd.push("-e", `GEMINI_API_KEY=${keyVal}`);
        dockerCmd.push("-e", `ANTHROPIC_API_KEY=${keyVal}`);
        dockerCmd.push("-e", `OPENAI_API_KEY=${keyVal}`);
      } else {
        // Forward from host environment only if present
        for (const envVar of ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
          dockerCmd.push("-e", envVar);
        }
      }

      // Extra custom docker flags
      if (this.dockerExtraFlags.trim()) {
        dockerCmd.push(...this.dockerExtraFlags.trim().split(/\s+/));
      }

      dockerCmd.push(selectedImage);

      // Option B: Auto-install on startup if binary is missing inside container
      if (this.binaryMode === "install") {
        const prog = agent.run[0] || "agy";
        const installScript = `if ! command -v ${prog} >/dev/null 2>&1; then curl -fsSL https://antigravity.google/cli/install.sh | bash && export PATH="$HOME/.local/bin:$PATH"; fi; exec "$@"`;
        dockerCmd.push("sh", "-c", installScript, "sh", ...finalArgv);
      } else {
        dockerCmd.push(...finalArgv);
      }

      finalArgv = dockerCmd;
    }

    // Save history & preferences
    if (task) {
      const nextHistory = [task, ...this.history.filter((h) => h !== task)].slice(0, 5);
      this.history = nextHistory;
      setShared(HISTORY_KEY, nextHistory);
    }
    if (!this.useCustomCommand) {
      setShared(LAST_AGENT_KEY, agent.key);
    }
    setShared(LAST_TARGET_KEY, this.target);
    setShared(LAST_MACHINE_KEY, this.selectedMachine);
    setShared(USE_DOCKER_KEY, this.useDocker);
    setShared(DOCKER_IMAGE_KEY, this.dockerImage.trim() || "herdr-agent:latest");
    setShared(DOCKER_CERTS_KEY, this.dockerMountCerts);
    setShared(DOCKER_BIN_MODE_KEY, this.binaryMode);
    if (this.gitName.trim()) setShared(GIT_NAME_KEY, this.gitName.trim());
    if (this.gitEmail.trim()) setShared(GIT_EMAIL_KEY, this.gitEmail.trim());

    // Close overlay first
    const ov = props()?.overlay;
    if (ov) {
      closeOverlay(ov);
    }

    const shortImg = (this.dockerImage.trim() || "docker").split("/").pop() || "docker";
    const title = this.useDocker ? `🐳 [${shortImg}] ${agent.name}` : agent.name;

    // Execute spawn based on target and machine
    if (this.target === "space") {
      const dirName = this.cwd.split("/").pop() || "agent";
      run("space.new", {
        name: `${title} (${dirName})`,
        machine: targetMachine || "",
        folder: this.cwd,
        argv: finalArgv,
      });
    } else if (this.target === "tab") {
      if (isSameMachine && activeSpace) {
        run("tab.new", {
          name: title,
          space: activeSpace.id,
          folder: this.cwd,
          argv: finalArgv,
        });
      } else {
        const spaceOnTarget = spaces().find((s) => (s.machine ?? null) === targetMachine);
        if (spaceOnTarget) {
          run("tab.new", {
            name: title,
            space: spaceOnTarget.id,
            folder: this.cwd,
            argv: finalArgv,
          });
        } else {
          run("space.new", {
            name: title,
            machine: targetMachine || "",
            folder: this.cwd,
            argv: finalArgv,
          });
        }
      }
    } else if (this.target === "split-right" || this.target === "split-down") {
      if (isSameMachine && activePane) {
        run("pane.split", {
          direction: this.target === "split-right" ? "right" : "down",
          pane: activePane.pane,
          argv: finalArgv,
        });
      } else {
        const spaceOnTarget = spaces().find((s) => (s.machine ?? null) === targetMachine);
        if (spaceOnTarget) {
          run("tab.new", {
            name: title,
            space: spaceOnTarget.id,
            folder: this.cwd,
            argv: finalArgv,
          });
        } else {
          run("space.new", {
            name: title,
            machine: targetMachine || "",
            folder: this.cwd,
            argv: finalArgv,
          });
        }
      }
    }

    const machineTag = targetMachine ? ` on ${targetMachine}` : "";
    notify({
      title: `Spawned ${title}${machineTag}`,
      body: this.useDocker
        ? `Isolated in ${shortImg}${machineTag} (workspace mounted to /workspace)`
        : task ? `Task: ${task.slice(0, 60)}` : `Agent started in ${this.cwd}${machineTag}`,
      level: "info",
    });
  }

  renderAgentBadge(a) {
    const t = theme();
    const isSelected = !this.useCustomCommand && this.selectedAgentKey === a.key;
    const iconEl = a.tint ? svg(a.icon).size(16).text_color(isSelected ? t.accent : t.foreground) : image(a.icon).size(16);

    return h_flex()
      .id(`agent-${a.key}`)
      .px(10)
      .py(6)
      .gap(8)
      .rounded(8)
      .items_center()
      .cursor_pointer()
      .border_1()
      .border_color(isSelected ? t.accent : t.border)
      .bg(isSelected ? t.selected : t.surface)
      .hover((s) => s.bg(isSelected ? t.selected : t.hover))
      .on_click((_e, cx) => {
        this.useCustomCommand = false;
        this.selectedAgentKey = a.key;
        cx.notify();
      })
      .child(iconEl)
      .child(
        v_flex()
          .gap(1)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(div().text_size(12.5).font_medium().text_color(t.foreground).child(a.name))
              .when(a.installed, (el) =>
                el.child(
                  div()
                    .px(4)
                    .py(1)
                    .rounded(4)
                    .bg(t.raised)
                    .text_size(9.5)
                    .text_color(t.working)
                    .child("Installed")
                )
              )
          )
      );
  }

  renderTargetButton(key, label, iconText) {
    const t = theme();
    const isSelected = this.target === key;

    return h_flex()
      .id(`target-${key}`)
      .flex_1()
      .h(32)
      .px(10)
      .gap(6)
      .items_center()
      .justify_center()
      .rounded(7)
      .cursor_pointer()
      .border_1()
      .border_color(isSelected ? t.accent : t.border)
      .bg(isSelected ? t.selected : t.surface)
      .text_color(isSelected ? t.accent : t.foreground)
      .text_size(12)
      .font_medium()
      .hover((s) => s.bg(isSelected ? t.selected : t.hover))
      .on_click((_e, cx) => {
        this.target = key;
        cx.notify();
      })
      .child(div().font_bold().child(iconText))
      .child(div().child(label));
  }

  renderBinModeButton(mode, label, iconText, desc) {
    const t = theme();
    const isSelected = this.binaryMode === mode;

    return h_flex()
      .id(`binmode-${mode}`)
      .flex_1()
      .h(30)
      .px(8)
      .gap(5)
      .items_center()
      .justify_center()
      .rounded(6)
      .cursor_pointer()
      .border_1()
      .border_color(isSelected ? t.accent : t.border)
      .bg(isSelected ? t.selected : t.background)
      .text_color(isSelected ? t.accent : t.foreground)
      .hover((s) => s.bg(isSelected ? t.selected : t.hover))
      .on_click((_e, cx) => {
        this.binaryMode = mode;
        cx.notify();
      })
      .child(div().font_bold().child(iconText))
      .child(div().text_size(11).font_medium().child(label));
  }

  render() {
    const t = theme();
    const selectedAgent = this.getSelectedAgent();
    const availableImages = Array.from(new Set([...this.localDockerImages, ...DEFAULT_DOCKER_IMAGES])).slice(0, 6);

    return v_flex()
      .id("agent-spawner-root")
      .track_focus(this.handle)
      .size_full()
      .bg(t.popover)
      .text_color(t.foreground)
      .p(16)
      .gap(10)
      .on_key_down((e) => {
        if (e.key === "Escape") {
          const ov = props()?.overlay;
          if (ov) closeOverlay(ov);
        } else if (e.key === "Enter" && (e.modifiers.control || e.modifiers.platform)) {
          this.spawn();
        }
      })
      // Header
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .gap(10)
              .items_center()
              .child(svg("icons/agent.svg").size(22).text_color(t.accent))
              .child(
                v_flex()
                  .child(div().text_size(16).font_bold().child("Spawn AI Agent"))
                  .child(div().text_size(11.5).text_color(t.dim).child("Easily launch coding agents with tasks into Herdr"))
              )
          )
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(div().text_size(11).text_color(t.dim).child("Ctrl+Shift+A · Esc to close"))
              .child(
                div()
                  .id("btn-close")
                  .size(24)
                  .rounded(6)
                  .items_center()
                  .justify_center()
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click(() => {
                    const ov = props()?.overlay;
                    if (ov) closeOverlay(ov);
                  })
                  .child(div().text_size(13).text_color(t.muted).child("✕"))
              )
          )
      )

      // Scrollable content body
      .child(
        v_flex()
          .id("spawner-scroll-content")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .gap(10)
          .pr(4)

          // Section 1: Choose Agent
          .child(
            v_flex()
              .gap(6)
              .child(
                h_flex()
                  .justify_between()
                  .items_center()
                  .child(
                    h_flex()
                      .gap(6)
                      .items_center()
                      .child(div().text_size(12).font_semibold().text_color(t.muted).child("1. SELECT AGENT"))
                      .when(this.loadingAgents, (el) =>
                        el.child(div().text_size(10.5).text_color(t.accent).child("(Checking agents...)"))
                      )
                  )
                  .child(
                    h_flex()
                      .gap(4)
                      .items_center()
                      .cursor_pointer()
                      .on_click((_e, cx) => {
                        this.useCustomCommand = !this.useCustomCommand;
                        cx.notify();
                      })
                      .child(
                        div()
                          .text_size(11)
                          .text_color(this.useCustomCommand ? t.accent : t.dim)
                          .child(this.useCustomCommand ? "← Choose known agent" : "Custom command...")
                      )
                  )
              )
              .when(!this.useCustomCommand, (el) =>
                el.child(
                  h_flex()
                    .flex_wrap()
                    .gap(6)
                    .children(this.agents.map((a) => this.renderAgentBadge(a)))
                )
              )
              .when(this.useCustomCommand, (el) =>
                el.child(
                  v_flex()
                    .gap(4)
                    .child(
                      Input.new(this.customInput)
                        .h(34)
                        .px(10)
                        .rounded(8)
                        .border_1()
                        .border_color(t.accent)
                        .bg(t.background)
                        .text_size(12)
                        .text_color(t.foreground)
                    )
                    .child(
                      div()
                        .text_size(11)
                        .text_color(t.dim)
                        .child("Type any CLI command to execute (e.g. 'agy --model flash' or 'aider --model sonnet')")
                    )
                )
              )
          )

          // Section 2: Target Machine
          .child(
            v_flex()
              .gap(6)
              .child(
                h_flex()
                  .justify_between()
                  .items_center()
                  .child(div().text_size(12).font_semibold().text_color(t.muted).child("2. TARGET MACHINE"))
                  .child(
                    div()
                      .text_size(11)
                      .text_color(this.selectedMachine ? t.accent : t.dim)
                      .child(this.selectedMachine ? `Remote: ${this.selectedMachine}` : "💻 Local Computer")
                  )
              )
              .child(
                h_flex()
                  .flex_wrap()
                  .gap(6)
                  .children(this.getAllMachines().map((m) => this.renderMachineButton(m)))
              )
          )

          // Section 3: Target placement
          .child(
            v_flex()
              .gap(6)
              .child(
                h_flex()
                  .justify_between()
                  .items_center()
                  .child(div().text_size(12).font_semibold().text_color(t.muted).child("3. SPAWN PLACEMENT"))
                  .when(Boolean(this.selectedMachine), (el) =>
                    el.child(div().text_size(11).text_color(t.dim).child("Target node: " + this.selectedMachine))
                  )
              )
              .child(
                h_flex()
                  .gap(6)
                  .child(this.renderTargetButton("tab", "New Tab", "⊞"))
                  .child(this.renderTargetButton("split-right", "Split Right", "◧"))
                  .child(this.renderTargetButton("split-down", "Split Down", "⬓"))
                  .child(this.renderTargetButton("space", "New Space", "❐"))
              )
          )

          // Section 4: Execution Environment (Host Environment vs Isolated Docker Container)
          .child(
            v_flex()
              .gap(6)
              .child(
                h_flex()
                  .justify_between()
                  .items_center()
                  .child(div().text_size(12).font_semibold().text_color(t.muted).child("4. EXECUTION ENVIRONMENT"))
                  .child(
                    div()
                      .text_size(11)
                      .text_color(this.useDocker ? t.accent : t.dim)
                      .child(
                        this.useDocker
                          ? "🐳 Isolated Docker Sandbox"
                          : this.selectedMachine
                          ? `💻 Remote Host (${this.selectedMachine})`
                          : "💻 Local Host Shell"
                      )
                  )
              )
              // Toggle buttons: Host vs Docker
              .child(
                h_flex()
                  .gap(6)
                  .child(
                    h_flex()
                      .id("env-local")
                      .flex_1()
                      .h(32)
                      .px(10)
                      .gap(6)
                      .items_center()
                      .justify_center()
                      .rounded(7)
                      .cursor_pointer()
                      .border_1()
                      .border_color(!this.useDocker ? t.accent : t.border)
                      .bg(!this.useDocker ? t.selected : t.surface)
                      .text_color(!this.useDocker ? t.accent : t.foreground)
                      .text_size(12)
                      .font_medium()
                      .hover((s) => s.bg(!this.useDocker ? t.selected : t.hover))
                      .on_click((_e, cx) => {
                        this.useDocker = false;
                        cx.notify();
                      })
                      .child(div().child(this.selectedMachine ? `💻 Remote Host (${this.selectedMachine})` : "💻 Local Host Shell"))
                  )
                  .child(
                    h_flex()
                      .id("env-docker")
                      .flex_1()
                      .h(32)
                      .px(10)
                      .gap(6)
                      .items_center()
                      .justify_center()
                      .rounded(7)
                      .cursor_pointer()
                      .border_1()
                      .border_color(this.useDocker ? t.accent : t.border)
                      .bg(this.useDocker ? t.selected : t.surface)
                      .text_color(this.useDocker ? t.accent : t.foreground)
                      .text_size(12)
                      .font_medium()
                      .hover((s) => s.bg(this.useDocker ? t.selected : t.hover))
                      .on_click((_e, cx) => {
                        this.useDocker = true;
                        cx.notify();
                      })
                      .child(div().child("🐳 Docker Sandbox"))
                  )
              )
              // Docker configuration panel
              .when(this.useDocker, (wrap) =>
                wrap.child(
                  v_flex()
                    .p(10)
                    .gap(8)
                    .rounded(8)
                    .border_1()
                    .border_color(t.accent)
                    .bg(t.surface)
                    // Image Input + Chips + Build Button
                    .child(
                      v_flex()
                        .gap(4)
                        .child(
                          h_flex()
                            .justify_between()
                            .items_center()
                            .child(div().text_size(11.5).font_medium().text_color(t.foreground).child("Docker Image:"))
                            .child(
                              h_flex()
                                .gap(6)
                                .items_center()
                                .child(
                                  h_flex()
                                    .id("btn-open-docker-dashboard")
                                    .px(8)
                                    .py(3)
                                    .rounded(5)
                                    .bg(t.input)
                                    .border_1()
                                    .border_color(t.border)
                                    .cursor_pointer()
                                    .hover((s) => s.bg(t.hover))
                                    .on_click(() => {
                                      run("mod.open", { name: "docker-dashboard" });
                                    })
                                    .child(div().text_size(11).text_color(t.foreground).child("📊 Dashboard"))
                                )
                                .child(
                                  h_flex()
                                    .id("btn-build-img")
                                    .px(8)
                                    .py(3)
                                    .rounded(5)
                                    .bg(this.isBuildingImage ? t.raised : t.solid)
                                    .cursor_pointer()
                                    .hover((s) => s.opacity(0.88))
                                    .on_click((_e, cx) => this.buildAgentImage(cx))
                                    .child(
                                      div()
                                        .text_size(11)
                                        .font_medium()
                                        .text_color(this.isBuildingImage ? t.dim : t.solid_foreground)
                                        .child(this.isBuildingImage ? "🔨 Building image..." : "🔨 Build 'herdr-agent'")
                                    )
                                )
                            )
                        )
                        .child(
                          Input.new(this.dockerImageInput)
                            .h(32)
                            .px(8)
                            .rounded(6)
                            .border_1()
                            .border_color(t.input)
                            .bg(t.background)
                            .text_size(12)
                            .text_color(t.foreground)
                        )
                        .child(
                          h_flex()
                            .flex_wrap()
                            .gap(4)
                            .children(
                              availableImages.map((img) =>
                                h_flex()
                                  .id(`img-chip-${img}`)
                                  .px(6)
                                  .py(2)
                                  .rounded(4)
                                  .bg(this.dockerImage === img ? t.selected : t.raised)
                                  .border_1()
                                  .border_color(this.dockerImage === img ? t.accent : t.border)
                                  .cursor_pointer()
                                  .hover((s) => s.bg(t.hover))
                                  .on_click((_e, cx) => {
                                    this.setDockerImage(img);
                                    if (img === "herdr-agent:latest") this.binaryMode = "image";
                                    cx.notify();
                                  })
                                  .child(div().text_size(10.5).text_color(t.foreground).child(img))
                              )
                            )
                        )
                    )
                    // Agent Binary Strategy Selector
                    .child(
                      v_flex()
                        .gap(4)
                        .child(div().text_size(11.5).font_medium().text_color(t.foreground).child("Agent Binary in Container:"))
                        .child(
                          h_flex()
                            .gap(4)
                            .child(this.renderBinModeButton("image", "Pre-installed in Image", "📦", "Uses image's own binary"))
                            .child(this.renderBinModeButton("mount", "Mount from Host", "🔗", "Mounts /usr/local/bin/agy:ro"))
                            .child(this.renderBinModeButton("install", "Install on Start", "⬇️", "Auto-installs if missing"))
                        )
                    )
                    // Volume Isolation Badge
                    .child(
                      h_flex()
                        .px(8)
                        .py(5)
                        .rounded(6)
                        .bg(t.background)
                        .gap(6)
                        .items_center()
                        .child(div().text_size(11).text_color(t.accent).child("🔒 Workspace Only:"))
                        .child(
                          div()
                            .flex_1()
                            .truncate()
                            .text_size(11)
                            .text_color(t.muted)
                            .child(`${this.cwd} → /workspace (Non-Root UID ${this.uid}:${this.gid})`)
                        )
                    )
                    // Git Integration (Author Name & Email)
                    .child(
                      v_flex()
                        .gap(4)
                        .child(div().text_size(11.5).font_medium().text_color(t.foreground).child("Git Integration (for commits inside container):"))
                        .child(
                          h_flex()
                            .gap(6)
                            .child(
                              v_flex()
                                .flex_1()
                                .gap(2)
                                .child(div().text_size(10.5).text_color(t.dim).child("Author Name"))
                                .child(
                              Input.new(this.gitNameInput)
                                .h(30)
                                .px(8)
                                .rounded(6)
                                .border_1()
                                .border_color(t.input)
                                .bg(t.background)
                                .text_size(11.5)
                                .text_color(t.foreground)
                            )
                        )
                        .child(
                          v_flex()
                            .flex_1()
                            .gap(2)
                            .child(div().text_size(10.5).text_color(t.dim).child("Author Email"))
                            .child(
                              Input.new(this.gitEmailInput)
                                .h(30)
                                .px(8)
                                .rounded(6)
                                .border_1()
                                .border_color(t.input)
                                .bg(t.background)
                                .text_size(11.5)
                                .text_color(t.foreground)
                            )
                        )
                    )
                )
                // API Key / Auth Integration
                .child(
                  v_flex()
                    .gap(3)
                    .child(
                      h_flex()
                        .justify_between()
                        .child(div().text_size(11.5).font_medium().text_color(t.foreground).child("API Key (Optional):"))
                        .child(div().text_size(10.5).text_color(t.dim).child("GEMINI_API_KEY / ANTHROPIC_API_KEY"))
                    )
                    .child(
                      Input.new(this.apiKeyInput)
                        .h(30)
                        .px(8)
                        .rounded(6)
                        .border_1()
                        .border_color(t.input)
                        .bg(t.background)
                        .text_size(11.5)
                        .text_color(t.foreground)
                    )
                )
                // Host Certificates Mount Toggle
                .child(
                  h_flex()
                    .id("btn-toggle-certs")
                    .gap(6)
                    .items_center()
                    .cursor_pointer()
                    .on_click((_e, cx) => {
                      this.dockerMountCerts = !this.dockerMountCerts;
                      cx.notify();
                    })
                    .child(
                      div()
                        .size(14)
                        .rounded(3)
                        .border_1()
                        .border_color(this.dockerMountCerts ? t.accent : t.dim)
                        .bg(this.dockerMountCerts ? t.accent : t.background)
                        .items_center()
                        .justify_center()
                        .text_size(10)
                        .font_bold()
                        .text_color(t.solid_foreground)
                        .child(this.dockerMountCerts ? "✓" : "")
                    )
                    .child(
                      div()
                        .text_size(11.5)
                        .text_color(t.foreground)
                        .child("Pass host SSL certificates (/etc/ssl/certs:ro) for HTTPS support")
                    )
                )
                // Extra flags
                .child(
                  v_flex()
                    .gap(2)
                    .child(div().text_size(10.5).text_color(t.dim).child("Extra Docker flags (optional):"))
                    .child(
                      Input.new(this.dockerExtraInput)
                        .h(28)
                        .px(8)
                        .rounded(6)
                        .border_1()
                        .border_color(t.border)
                        .bg(t.background)
                        .text_size(11.5)
                        .text_color(t.foreground)
                    )
                )
            )
          )
      )

      // Section 5: Workspace Directory
      .child(
        v_flex()
          .gap(6)
          .child(
            h_flex()
              .justify_between()
              .items_center()
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .child(div().text_size(12).font_semibold().text_color(t.muted).child("5. WORKSPACE DIRECTORY"))
                  .when(Boolean(this.selectedMachine), (el) =>
                    el.child(
                      div()
                        .px(5)
                        .py(1)
                        .rounded(4)
                        .bg(t.selected)
                        .text_size(9.5)
                        .font_medium()
                        .text_color(t.accent)
                        .child(`Remote: ${this.selectedMachine}`)
                    )
                  )
              )
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .child(
                    h_flex()
                      .id("btn-toggle-tree")
                      .px(8)
                      .py(2)
                      .rounded(5)
                      .bg(this.showTree ? t.selected : t.raised)
                      .border_1()
                      .border_color(this.showTree ? t.accent : t.border)
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover))
                      .on_click((_e, cx) => {
                        this.showTree = !this.showTree;
                        if (this.showTree && !this.treeRoot) {
                          this.initTreeForCurrentMachine(cx);
                        }
                        cx.notify();
                      })
                      .child(
                        div()
                          .text_size(11)
                          .font_medium()
                          .text_color(this.showTree ? t.accent : t.muted)
                          .child(this.showTree ? "📂 Hide Tree" : "🌳 Directory Tree")
                      )
                  )
              )
          )
          .child(
            v_flex()
              .gap(6)
              .child(
                h_flex()
                  .h(34)
                  .gap(6)
                  .items_center()
                  .child(
                    Input.new(this.cwdInput)
                      .flex_1()
                      .h(34)
                      .px(10)
                      .rounded(8)
                      .border_1()
                      .border_color(t.input)
                      .bg(t.background)
                      .text_size(12)
                      .text_color(t.foreground)
                  )
                  .when(!this.selectedMachine, (el) =>
                    el.child(
                      h_flex()
                        .h(34)
                        .px(10)
                        .rounded(8)
                        .bg(t.raised)
                        .border_1()
                        .border_color(t.border)
                        .cursor_pointer()
                        .items_center()
                        .hover((s) => s.bg(t.hover))
                        .on_click((_e, cx) => this.browseFolder(cx))
                        .child(div().text_size(11.5).text_color(t.foreground).child("Browse..."))
                    )
                  )
              )
              // Render Directory Tree when enabled
              .when(this.showTree, (el) => el.child(this.renderDirectoryTree()))
              .when(!this.showTree, (el) =>
                el.child(
                  div()
                    .text_size(10.5)
                    .text_color(t.dim)
                    .child(
                      this.selectedMachine
                        ? `Path on remote machine ${this.selectedMachine} (click 'Directory Tree' to visually explore folders)`
                        : "Directory path on this computer where the agent process will start"
                    )
                )
              )
          )
      )

      // Section 6: Initial Task / Prompt
      .child(
        v_flex()
          .gap(6)
          .child(
            h_flex()
              .justify_between()
              .items_center()
              .child(div().text_size(12).font_semibold().text_color(t.muted).child("6. INITIAL TASK / PROMPT"))
              .child(div().text_size(11).text_color(t.dim).child("Press Enter to spawn"))
          )
          .child(
            Input.new(this.taskInput)
              .h(36)
              .px(10)
              .rounded(8)
              .border_1()
              .border_color(t.input)
              .bg(t.background)
              .text_size(12.5)
              .text_color(t.foreground)
          )
          // Presets
          .child(
            h_flex()
              .flex_wrap()
              .gap(6)
              .children(
                PRESET_PROMPTS.map((p, idx) =>
                  h_flex()
                    .id(`preset-${idx}`)
                    .px(8)
                    .py(3)
                    .rounded(6)
                    .bg(t.surface)
                    .border_1()
                    .border_color(t.border)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => {
                      this.setPreset(p.text);
                      cx.notify();
                    })
                    .child(div().text_size(11).text_color(t.foreground).child(p.label))
                )
              )
          )
          // Recent history
          .when(this.history.length > 0, (el) =>
            el.child(
              h_flex()
                .gap(6)
                .items_center()
                .child(div().text_size(10.5).text_color(t.dim).child("Recent:"))
                .children(
                  this.history.slice(0, 3).map((item, idx) =>
                    h_flex()
                      .id(`hist-${idx}`)
                      .px(6)
                      .py(2)
                      .rounded(4)
                      .bg(t.raised)
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover))
                      .on_click((_e, cx) => {
                        this.setPreset(item);
                        cx.notify();
                      })
                      .child(
                        div()
                          .max_w(140)
                          .truncate()
                          .text_size(10.5)
                          .text_color(t.muted)
                          .child(item)
                      )
                  )
                )
            )
          )
      )
      )

      // Footer: Action Buttons
      .child(
        h_flex()
          .pt(4)
          .gap(10)
          .justify_end()
          .items_center()
          .child(
            h_flex()
              .id("btn-cancel")
              .h(34)
              .px(14)
              .rounded(8)
              .items_center()
              .cursor_pointer()
              .border_1()
              .border_color(t.border)
              .bg(t.raised)
              .hover((s) => s.bg(t.hover))
              .on_click(() => {
                const ov = props()?.overlay;
                if (ov) closeOverlay(ov);
              })
              .child(div().text_size(12).text_color(t.foreground).child("Cancel"))
          )
          .child(
            h_flex()
              .id("btn-spawn")
              .h(34)
              .px(18)
              .gap(6)
              .rounded(8)
              .items_center()
              .cursor_pointer()
              .bg(t.solid)
              .hover((s) => s.opacity(0.9))
              .on_click(() => this.spawn())
              .child(
                div()
                  .text_size(12.5)
                  .font_semibold()
                  .text_color(t.solid_foreground)
                  .child(
                    this.useDocker
                      ? `🐳 Spawn in Docker (${selectedAgent?.name || "Agent"})${this.selectedMachine ? ` on ${this.selectedMachine}` : ""}`
                      : `🚀 Spawn ${selectedAgent?.name || "Agent"}${this.selectedMachine ? ` on ${this.selectedMachine}` : ""}`
                  )
              )
          )
      );
  }
}
