import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
  theme,
  spaces,
  panes,
  run,
  closeOverlay,
  props,
  shared,
  setShared,
  notify,
  exec,
  home,
} from "herdr";

export default class DockerDashboard extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();

    this.alive = true;
    this.loading = true;
    this.activeTab = "containers"; // "containers" | "images" | "system"
    this.containerFilter = "all"; // "all" | "running" | "stopped" | "agents"
    this.searchQuery = "";

    this.containers = [];
    this.stats = new Map(); // id -> stats object
    this.images = [];
    this.df = null;
    this.inspectData = null; // { container, json }
    this.isActionPending = false;
    this.lastRefreshed = new Date();

    this.panelWidth = 400;
    this.searchInput = InputState.new({
      placeholder: "Filter containers by name, image, or ID...",
    });
    this.searchInput.on("change", (_e, cx) => {
      this.searchQuery = this.searchInput.value().toLowerCase().trim();
      cx.notify();
    });

    // Initial fetch
    cx.spawn(async (cx) => {
      await this.refresh(cx);
    });

    // Polling loop every 4 seconds while dashboard is open
    cx.spawn(async (cx) => {
      while (this.alive) {
        await cx.sleep(4000);
        if (!this.alive) break;
        await this.refresh(cx, true);
      }
    });
  }

  close(_cx) {
    this.alive = false;
  }

  async refresh(cx, silent = false) {
    if (!silent) {
      this.loading = true;
      cx.notify();
    }

    try {
      // 1. Fetch Containers
      const psRes = await exec("docker", ["ps", "-a", "--format", "{{json .}}"]);
      const rawLines = (psRes?.stdout ?? "").trim().split("\n").filter(Boolean);
      const parsedContainers = [];
      for (const line of rawLines) {
        try {
          const item = JSON.parse(line);
          const isAgent = /herdr-agent|herder-agent|agent|agy|claude|workspace|codex|gemini/i.test(
            (item.Names || "") + " " + (item.Image || "") + " " + (item.Labels || "") + " " + (item.Command || "")
          );
          parsedContainers.push({
            ...item,
            isAgent,
            isRunning: (item.State || "").toLowerCase() === "running",
          });
        } catch {
          // ignore malformed line
        }
      }
      this.containers = parsedContainers;

      // 2. Fetch Live Stats for running containers
      const statsRes = await exec("docker", ["stats", "--no-stream", "--format", "{{json .}}"]);
      const statsLines = (statsRes?.stdout ?? "").trim().split("\n").filter(Boolean);
      const newStats = new Map();
      for (const line of statsLines) {
        try {
          const s = JSON.parse(line);
          const id = (s.ID || s.Container || "").slice(0, 12);
          if (id) newStats.set(id, s);
          if (s.Name) newStats.set(s.Name, s);
        } catch {
          // ignore
        }
      }
      this.stats = newStats;

      // 3. Fetch Images if on images tab or first load
      const imgRes = await exec("docker", ["images", "--format", "{{json .}}"]);
      const imgLines = (imgRes?.stdout ?? "").trim().split("\n").filter(Boolean);
      const parsedImages = [];
      for (const line of imgLines) {
        try {
          const img = JSON.parse(line);
          if (img.Repository && !img.Repository.includes("<none>")) {
            parsedImages.push(img);
          }
        } catch {
          // ignore
        }
      }
      this.images = parsedImages;

      // 4. Update timestamp
      this.lastRefreshed = new Date();
    } catch (err) {
      if (!silent) {
        notify({ title: "Docker Query Failed", body: String(err), level: "error" });
      }
    } finally {
      this.loading = false;
      cx.notify();
    }
  }

  async fetchSystemDf(cx) {
    try {
      const res = await exec("docker", ["system", "df"]);
      this.df = res?.stdout ?? "";
      cx.notify();
    } catch {
      this.df = "Unable to query docker system df";
    }
  }

  openShell(c) {
    const name = c.Names || c.ID.slice(0, 8);
    run("tab.new", {
      name: `>_ [Docker] ${name}`,
      argv: ["docker", "exec", "-it", c.ID, "sh"],
    });
    notify({ title: "Container Shell", body: `Launched interactive shell for ${name}` });
  }

  openLogs(c) {
    const name = c.Names || c.ID.slice(0, 8);
    run("tab.new", {
      name: `📜 [Logs] ${name}`,
      argv: ["docker", "logs", "-f", "--tail", "250", c.ID],
    });
    notify({ title: "Streaming Logs", body: `Opened log stream for ${name}` });
  }

  async startContainer(c, cx) {
    if (this.isActionPending) return;
    this.isActionPending = true;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const res = await exec("docker", ["start", c.ID]);
        if (res.code === 0) {
          notify({ title: "Container Started", body: c.Names || c.ID });
        } else {
          notify({ title: "Start Failed", body: res.stderr, level: "error" });
        }
      } finally {
        this.isActionPending = false;
        await this.refresh(cx);
      }
    });
  }

  async stopContainer(c, cx) {
    if (this.isActionPending) return;
    this.isActionPending = true;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const res = await exec("docker", ["stop", c.ID]);
        if (res.code === 0) {
          notify({ title: "Container Stopped", body: c.Names || c.ID });
        } else {
          notify({ title: "Stop Failed", body: res.stderr, level: "error" });
        }
      } finally {
        this.isActionPending = false;
        await this.refresh(cx);
      }
    });
  }

  async restartContainer(c, cx) {
    if (this.isActionPending) return;
    this.isActionPending = true;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const res = await exec("docker", ["restart", c.ID]);
        if (res.code === 0) {
          notify({ title: "Container Restarted", body: c.Names || c.ID });
        } else {
          notify({ title: "Restart Failed", body: res.stderr, level: "error" });
        }
      } finally {
        this.isActionPending = false;
        await this.refresh(cx);
      }
    });
  }

  async removeContainer(c, cx) {
    if (this.isActionPending) return;
    this.isActionPending = true;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const res = await exec("docker", ["rm", "-f", c.ID]);
        if (res.code === 0) {
          notify({ title: "Container Removed", body: c.Names || c.ID });
        } else {
          notify({ title: "Remove Failed", body: res.stderr, level: "error" });
        }
      } finally {
        this.isActionPending = false;
        await this.refresh(cx);
      }
    });
  }

  async inspectContainer(c, cx) {
    try {
      const res = await exec("docker", ["inspect", c.ID]);
      if (res.code === 0) {
        const parsed = JSON.parse(res.stdout);
        this.inspectData = {
          container: c,
          raw: parsed[0] || parsed,
        };
      }
    } catch (err) {
      notify({ title: "Inspect Failed", body: String(err), level: "error" });
    } finally {
      cx.notify();
    }
  }

  spawnAgentInImage(imageName) {
    setShared("agent-spawner.docker-image", imageName);
    setShared("agent-spawner.use-docker", true);
    run("mod.open", { name: "agent-spawner" });
  }

  async deleteImage(img, cx) {
    if (this.isActionPending) return;
    this.isActionPending = true;
    cx.notify();

    const tag = img.Repository + (img.Tag ? `:${img.Tag}` : "");
    cx.spawn(async (cx) => {
      try {
        const res = await exec("docker", ["rmi", tag]);
        if (res.code === 0) {
          notify({ title: "Image Deleted", body: tag });
        } else {
          notify({ title: "Delete Failed", body: res.stderr, level: "error" });
        }
      } finally {
        this.isActionPending = false;
        await this.refresh(cx);
      }
    });
  }

  async pruneContainers(cx) {
    if (this.isActionPending) return;
    this.isActionPending = true;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const res = await exec("docker", ["container", "prune", "-f"]);
        notify({ title: "Containers Pruned", body: res.stdout.slice(0, 100) });
      } finally {
        this.isActionPending = false;
        await this.refresh(cx);
        await this.fetchSystemDf(cx);
      }
    });
  }

  async pruneImages(cx) {
    if (this.isActionPending) return;
    this.isActionPending = true;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const res = await exec("docker", ["image", "prune", "-f"]);
        notify({ title: "Images Pruned", body: res.stdout.slice(0, 100) });
      } finally {
        this.isActionPending = false;
        await this.refresh(cx);
        await this.fetchSystemDf(cx);
      }
    });
  }

  async buildHerdrAgent(cx) {
    if (this.isActionPending) return;
    this.isActionPending = true;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const h = home();
        const dockerDir = "/home/ben/Documents/projects/herdr-plugins/agent-spawner/docker";
        await exec("cp", [`${h}/.local/bin/agy`, `${dockerDir}/agy`]);
        const res = await exec("docker", ["build", "-t", "herdr-agent:latest", dockerDir]);
        if (res.code === 0) {
          notify({ title: "Image Built", body: "herdr-agent:latest ready for isolated sandboxes" });
        } else {
          notify({ title: "Build Failed", body: res.stderr, level: "error" });
        }
      } finally {
        this.isActionPending = false;
        await this.refresh(cx);
      }
    });
  }

  closeModal() {
    const ov = props()?.overlay;
    if (ov) {
      closeOverlay(ov);
    } else {
      run("layout.hide", { id: "docker-sidebar" });
    }
  }

  renderHeader() {
    const t = theme();
    const runningCount = this.containers.filter((c) => c.isRunning).length;

    return v_flex()
      .p(10)
      .gap(8)
      .border_b_1()
      .border_color(t.border)
      .child(
        // Line 1: Title, Logo, Active Count, Close Button
        h_flex()
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(
                div()
                  .w(26)
                  .h(26)
                  .rounded(6)
                  .bg("#2496ed")
                  .flex()
                  .items_center()
                  .justify_center()
                  .child(svg("icons/docker.svg").size(15).text_color("#ffffff"))
              )
              .child(
                div()
                  .text_size(14)
                  .font_weight(700)
                  .text_color(t.foreground)
                  .child("Docker Containers")
              )
              .child(
                div()
                  .px(6)
                  .py(1)
                  .rounded(10)
                  .bg(t.surface)
                  .border_1()
                  .border_color(t.border)
                  .text_size(10.5)
                  .text_color(t.accent)
                  .child(`${runningCount} active`)
              )
          )
          .child(
            div()
              .w(24)
              .h(24)
              .rounded(5)
              .flex()
              .items_center()
              .justify_center()
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click(() => this.closeModal())
              .child(div().text_size(13).text_color(t.muted).child("✕"))
          )
      )
      .child(
        // Line 2: Toolbar buttons on a new line!
        h_flex()
          .items_center()
          .justify_between()
          .gap(8)
          .child(
            div()
              .text_size(11)
              .text_color(t.muted)
              .child(`${this.containers.length} containers · ${this.images.length} images`)
          )
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(
                h_flex()
                  .px(8)
                  .py(4)
                  .rounded(5)
                  .bg(t.surface)
                  .border_1()
                  .border_color(t.border)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .gap(4)
                  .items_center()
                  .on_click((_e, cx) => this.refresh(cx))
                  .child(div().text_size(11).child("🔄"))
                  .child(div().text_size(11.5).text_color(t.foreground).child("Refresh"))
              )
              .child(
                h_flex()
                  .px(9)
                  .py(4)
                  .rounded(5)
                  .bg(t.accent)
                  .cursor_pointer()
                  .hover((s) => s.opacity(0.85))
                  .items_center()
                  .gap(4)
                  .on_click(() => {
                    run("mod.open", { name: "agent-spawner" });
                  })
                  .child(div().text_size(11).child("🚀"))
                  .child(div().text_size(11.5).font_weight(600).text_color(t.accent_foreground).child("Spawn Agent"))
              )
          )
      );
  }

  renderTabs() {
    const t = theme();
    const isNarrow = (this.panelWidth || 400) < 380;
    const isVeryNarrow = (this.panelWidth || 400) < 300;

    const tabs = [
      {
        id: "containers",
        label: isVeryNarrow
          ? `🐳 ${this.containers.length}`
          : isNarrow
          ? `🐳 Cont (${this.containers.length})`
          : `🐳 Containers (${this.containers.length})`,
      },
      {
        id: "images",
        label: isVeryNarrow
          ? `📦 ${this.images.length}`
          : isNarrow
          ? `📦 Img (${this.images.length})`
          : `📦 Images (${this.images.length})`,
      },
      {
        id: "system",
        label: isVeryNarrow ? "🧹" : isNarrow ? "🧹 Clean" : "🧹 Cleanup & System",
      },
    ];

    return h_flex()
      .px(isNarrow ? 6 : 12)
      .pt(6)
      .gap(4)
      .border_b_1()
      .border_color(t.border)
      .bg(t.surface)
      .items_center()
      .children(
        tabs.map((tab) => {
          const isActive = this.activeTab === tab.id;
          return h_flex()
            .flex_1()
            .justify_center()
            .px(isNarrow ? 4 : 8)
            .py(6)
            .items_center()
            .cursor_pointer()
            .border_b_2()
            .border_color(isActive ? t.accent : "#00000000")
            .text_color(isActive ? t.accent : t.muted)
            .hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => {
              this.activeTab = tab.id;
              if (tab.id === "system" && !this.df) {
                this.fetchSystemDf(cx);
              }
              cx.notify();
            })
            .child(
              div()
                .text_size(isNarrow ? 11.5 : 12.5)
                .font_weight(isActive ? 600 : 400)
                .child(tab.label)
            );
        })
      );
  }

  renderContainersTab() {
    const t = theme();

    // Filter logic
    const query = this.searchQuery;
    const filtered = this.containers.filter((c) => {
      if (this.containerFilter === "running" && !c.isRunning) return false;
      if (this.containerFilter === "stopped" && c.isRunning) return false;
      if (this.containerFilter === "agents" && !c.isAgent) return false;

      if (!query) return true;
      const haystack = `${c.Names} ${c.Image} ${c.ID} ${c.Ports || ""} ${c.Status}`.toLowerCase();
      return haystack.includes(query);
    });

    const runningTotal = this.containers.filter((c) => c.isRunning).length;
    const stoppedTotal = this.containers.length - runningTotal;
    const agentTotal = this.containers.filter((c) => c.isAgent).length;

    const filterChips = [
      { id: "all", label: `All (${this.containers.length})` },
      { id: "running", label: `Running (${runningTotal})` },
      { id: "stopped", label: `Stopped (${stoppedTotal})` },
      { id: "agents", label: `🤖 Agent Sandboxes (${agentTotal})` },
    ];

    return v_flex()
      .flex_1()
      .min_h(0)
      .p(12)
      .gap(10)
      .child(
        // Filter & Search Row
        v_flex()
          .gap(8)
          .child(
            h_flex()
              .flex_wrap()
              .gap(6)
              .children(
                filterChips.map((chip) => {
                  const sel = this.containerFilter === chip.id;
                  return div()
                    .px(8)
                    .py(4)
                    .rounded(6)
                    .border_1()
                    .border_color(sel ? t.accent : t.border)
                    .bg(sel ? t.selected : t.surface)
                    .text_color(sel ? t.accent : t.muted)
                    .text_size(11.5)
                    .cursor_pointer()
                    .hover((s) => s.bg(sel ? t.selected : t.hover))
                    .on_click((_e, cx) => {
                      this.containerFilter = chip.id;
                      cx.notify();
                    })
                    .child(chip.label);
                })
              )
          )
          .child(
            Input.new(this.searchInput)
              .w_full()
              .px(10)
              .py(6)
              .rounded(6)
              .border_1()
              .border_color(t.border)
              .bg(t.input)
              .text_color(t.foreground)
              .text_size(12.5)
          )
      )
      .child(
        // Scrollable Container List
        v_flex()
          .id("container-list-scroll")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .gap(8)
          .children(
            filtered.length === 0
              ? [
                  v_flex()
                    .p(40)
                    .items_center()
                    .justify_center()
                    .gap(8)
                    .child(div().text_size(28).child("📦"))
                    .child(
                      div()
                        .text_size(14)
                        .font_weight(600)
                        .text_color(t.foreground)
                        .child("No containers matching your criteria")
                    )
                    .child(
                      div()
                        .text_size(12)
                        .text_color(t.muted)
                        .child("Launch an agent in a sandbox with 'Spawn Agent'")
                    ),
                ]
              : filtered.map((c) => this.renderContainerCard(c))
          )
      );
  }

  renderContainerCard(c) {
    const t = theme();
    const stat = this.stats.get(c.ID.slice(0, 12)) || this.stats.get(c.Names) || null;
    const cpuStr = stat?.CPUPerc || null;
    const memStr = stat?.MemUsage || null;
    const memPerc = stat?.MemPerc || null;

    return v_flex()
      .id(`container-${c.ID}`)
      .p(10)
      .rounded(8)
      .border_1()
      .border_color(c.isRunning ? (c.isAgent ? "#8b5cf6" : t.border) : t.border)
      .bg(t.surface)
      .gap(8)
      .hover((s) => s.border_color(t.accent))
      .child(
        // Line 1: Status Dot, Container Name (flex_1), Status Text
        h_flex()
          .items_center()
          .justify_between()
          .gap(8)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .flex_1()
              .min_w(0)
              .child(
                div()
                  .w(8)
                  .h(8)
                  .rounded(4)
                  .bg(c.isRunning ? "#22c55e" : "#64748b")
              )
              .child(
                div()
                  .font_weight(600)
                  .text_size(13.5)
                  .text_color(t.foreground)
                  .child(c.Names || c.ID.slice(0, 12))
              )
          )
          .child(
            div()
              .text_size(11)
              .text_color(c.isRunning ? "#22c55e" : t.muted)
              .child(c.Status)
          )
      )
      .child(
        // Line 2: Badges (ID, Image, Agent Tag) wrapping freely
        h_flex()
          .flex_wrap()
          .gap(6)
          .items_center()
          .child(
            div()
              .px(5)
              .py(1)
              .rounded(4)
              .bg(t.input)
              .border_1()
              .border_color(t.border)
              .text_size(10.5)
              .text_color(t.muted)
              .child(c.ID.slice(0, 10))
          )
          .child(
            div()
              .px(6)
              .py(1)
              .rounded(4)
              .bg(t.selected)
              .border_1()
              .border_color(t.border)
              .text_size(10.5)
              .text_color(t.accent)
              .child(c.Image)
          )
          .when(Boolean(c.isAgent), (el) =>
            el.child(
              div()
                .px(6)
                .py(1)
                .rounded(10)
                .bg("#8b5cf622")
                .border_1()
                .border_color("#8b5cf6")
                .text_size(10.5)
                .font_weight(600)
                .text_color("#a78bfa")
                .child("🤖 Agent Sandbox")
            )
          )
      )
      .child(
        // Line 3: Ports, Mounts & Live Stats (wrapping freely)
        h_flex()
          .flex_wrap()
          .items_center()
          .justify_between()
          .gap(6)
          .child(
            h_flex()
              .flex_wrap()
              .gap(8)
              .items_center()
              .when(Boolean(c.Ports), (el) =>
                el.child(
                  h_flex()
                    .gap(3)
                    .items_center()
                    .child(div().text_size(10).text_color(t.muted).child("🌐"))
                    .child(
                      div()
                        .text_size(11)
                        .text_color(t.foreground)
                        .child(c.Ports.split(",")[0] || c.Ports)
                    )
                )
              )
              .when(Boolean(c.Mounts), (el) =>
                el.child(
                  h_flex()
                    .gap(3)
                    .items_center()
                    .child(div().text_size(10).text_color(t.muted).child("📁"))
                    .child(div().text_size(11).text_color(t.muted).child(c.Mounts))
                )
              )
          )
          .child(
            stat && c.isRunning
              ? h_flex()
                  .gap(5)
                  .items_center()
                  .child(
                    h_flex()
                      .px(5)
                      .py(1.5)
                      .rounded(4)
                      .bg(t.input)
                      .gap(3)
                      .child(div().text_size(10).text_color(t.muted).child("CPU"))
                      .child(
                        div()
                          .text_size(10)
                          .font_weight(600)
                          .text_color(parseFloat(cpuStr) > 50 ? "#ef4444" : "#22c55e")
                          .child(cpuStr)
                      )
                  )
                  .child(
                    h_flex()
                      .px(5)
                      .py(1.5)
                      .rounded(4)
                      .bg(t.input)
                      .gap(3)
                      .child(div().text_size(10).text_color(t.muted).child("RAM"))
                      .child(
                        div()
                          .text_size(10)
                          .font_weight(600)
                          .text_color(t.accent)
                          .child(`${memStr ? memStr.split("/")[0].trim() : ""} (${memPerc || ""})`)
                      )
                  )
              : div()
          )
      )
      .child(
        // Line 4: Action Buttons (wrapping freely)
        h_flex()
          .flex_wrap()
          .items_center()
          .justify_between()
          .pt(6)
          .gap(5)
          .border_t_1()
          .border_color(t.border)
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .child(
                h_flex()
                  .px(7)
                  .py(3.5)
                  .rounded(4)
                  .bg(t.input)
                  .border_1()
                  .border_color(t.border)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .gap(3)
                  .items_center()
                  .on_click(() => this.openShell(c))
                  .child(div().text_size(11).child(">_"))
                  .child(div().text_size(11).text_color(t.foreground).child("Shell"))
              )
              .child(
                h_flex()
                  .px(7)
                  .py(3.5)
                  .rounded(4)
                  .bg(t.input)
                  .border_1()
                  .border_color(t.border)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .gap(3)
                  .items_center()
                  .on_click(() => this.openLogs(c))
                  .child(div().text_size(11).child("📜"))
                  .child(div().text_size(11).text_color(t.foreground).child("Logs"))
              )
              .child(
                h_flex()
                  .px(7)
                  .py(3.5)
                  .rounded(4)
                  .bg(t.input)
                  .border_1()
                  .border_color(t.border)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .gap(3)
                  .items_center()
                  .on_click((_e, cx) => this.inspectContainer(c, cx))
                  .child(div().text_size(11).child("🔍"))
                  .child(div().text_size(11).text_color(t.foreground).child("Inspect"))
              )
          )
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .child(
                c.isRunning
                  ? h_flex()
                      .px(7)
                      .py(3.5)
                      .rounded(4)
                      .bg(t.input)
                      .border_1()
                      .border_color(t.border)
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover))
                      .gap(3)
                      .items_center()
                      .on_click((_e, cx) => this.restartContainer(c, cx))
                      .child(div().text_size(11).child("🔄"))
                      .child(div().text_size(11).text_color(t.foreground).child("Restart"))
                  : div()
              )
              .child(
                c.isRunning
                  ? h_flex()
                      .px(7)
                      .py(3.5)
                      .rounded(4)
                      .bg("#ef444422")
                      .border_1()
                      .border_color("#ef444466")
                      .cursor_pointer()
                      .hover((s) => s.bg("#ef444433"))
                      .gap(3)
                      .items_center()
                      .on_click((_e, cx) => this.stopContainer(c, cx))
                      .child(div().text_size(11).child("⏹"))
                      .child(div().text_size(11).text_color("#f87171").child("Stop"))
                  : h_flex()
                      .px(7)
                      .py(3.5)
                      .rounded(4)
                      .bg("#22c55e22")
                      .border_1()
                      .border_color("#22c55e66")
                      .cursor_pointer()
                      .hover((s) => s.bg("#22c55e33"))
                      .gap(3)
                      .items_center()
                      .on_click((_e, cx) => this.startContainer(c, cx))
                      .child(div().text_size(11).child("▶"))
                      .child(div().text_size(11).text_color("#4ade80").child("Start"))
              )
              .child(
                h_flex()
                  .px(6)
                  .py(3.5)
                  .rounded(4)
                  .bg(t.input)
                  .border_1()
                  .border_color(t.border)
                  .cursor_pointer()
                  .hover((s) => s.bg("#ef444422"))
                  .items_center()
                  .on_click((_e, cx) => this.removeContainer(c, cx))
                  .child(div().text_size(11).child("🗑"))
              )
          )
      );
  }

  renderImagesTab() {
    const t = theme();
    return v_flex()
      .flex_1()
      .min_h(0)
      .p(16)
      .gap(12)
      .child(
        // Top banner: build herdr-agent or prune
        h_flex()
          .p(12)
          .rounded(8)
          .bg(t.surface)
          .border_1()
          .border_color(t.border)
          .items_center()
          .justify_between()
          .child(
            v_flex()
              .gap(2)
              .child(
                div()
                  .font_weight(600)
                  .text_size(13)
                  .text_color(t.foreground)
                  .child("Herdr Agent Sandbox Image")
              )
              .child(
                div()
                  .text_size(12)
                  .text_color(t.muted)
                  .child("Pre-packages Antigravity CLI, git, curl, and SSL certificates for non-root isolation")
              )
          )
          .child(
            h_flex()
              .px(10)
              .py(6)
              .rounded(6)
              .bg(t.accent)
              .cursor_pointer()
              .hover((s) => s.opacity(0.85))
              .gap(6)
              .items_center()
              .on_click((_e, cx) => this.buildHerdrAgent(cx))
              .child(div().text_size(13).child("🔨"))
              .child(
                div()
                  .font_weight(600)
                  .text_size(12)
                  .text_color(t.accent_foreground)
                  .child("Build 'herdr-agent' Image")
              )
          )
      )
      .child(
        // Scrollable Images Table
        v_flex()
          .id("images-list-scroll")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .gap(8)
          .children(
            this.images.map((img) => {
              const fullTag = `${img.Repository}:${img.Tag || "latest"}`;
              const isHerdrAgent = img.Repository === "herdr-agent";

              return h_flex()
                .id(`img-${img.ID}-${img.Tag}`)
                .p(12)
                .rounded(8)
                .border_1()
                .border_color(isHerdrAgent ? "#8b5cf6" : t.border)
                .bg(t.surface)
                .items_center()
                .justify_between()
                .child(
                  v_flex()
                    .gap(4)
                    .child(
                      h_flex()
                        .gap(8)
                        .items_center()
                        .child(
                          div()
                            .font_weight(600)
                            .text_size(14)
                            .text_color(t.foreground)
                            .child(fullTag)
                        )
                        .child(
                          isHerdrAgent
                            ? div()
                                .px(6)
                                .py(1)
                                .rounded(12)
                                .bg("#8b5cf622")
                                .border_1()
                                .border_color("#8b5cf6")
                                .text_size(11)
                                .text_color("#a78bfa")
                                .child("Recommended")
                            : div()
                        )
                    )
                    .child(
                      h_flex()
                        .gap(12)
                        .child(
                          div()
                            .text_size(12)
                            .text_color(t.muted)
                            .child(`Size: ${img.Size || "N/A"}`)
                        )
                        .child(
                          div()
                            .text_size(12)
                            .text_color(t.muted)
                            .child(`Created: ${img.CreatedSince || "N/A"}`)
                        )
                        .child(
                          div()
                            .text_size(11)
                            .text_color(t.muted)
                            .child(`ID: ${img.ID.slice(0, 12)}`)
                        )
                    )
                )
                .child(
                  h_flex()
                    .gap(6)
                    .child(
                      h_flex()
                        .px(10)
                        .py(5)
                        .rounded(6)
                        .bg(t.selected)
                        .border_1()
                        .border_color(t.accent)
                        .cursor_pointer()
                        .hover((s) => s.bg(t.hover))
                        .gap(6)
                        .items_center()
                        .on_click(() => this.spawnAgentInImage(fullTag))
                        .child(div().text_size(12).child("🚀"))
                        .child(
                          div()
                            .font_weight(600)
                            .text_size(12)
                            .text_color(t.accent)
                            .child("Spawn Agent")
                        )
                    )
                    .child(
                      h_flex()
                        .px(8)
                        .py(5)
                        .rounded(6)
                        .bg(t.input)
                        .border_1()
                        .border_color(t.border)
                        .cursor_pointer()
                        .hover((s) => s.bg("#ef444422"))
                        .on_click((_e, cx) => this.deleteImage(img, cx))
                        .child(div().text_size(12).text_color(t.muted).child("🗑"))
                    )
                );
            })
          )
      );
  }

  renderSystemTab() {
    const t = theme();
    return v_flex()
      .flex_1()
      .min_h(0)
      .p(16)
      .gap(16)
      .child(
        // Quick Prune Actions Grid
        v_flex()
          .gap(8)
          .child(
            div()
              .text_size(14)
              .font_weight(600)
              .text_color(t.foreground)
              .child("Docker Storage Cleanup")
          )
          .child(
            h_flex()
              .gap(10)
              .child(
                v_flex()
                  .flex_1()
                  .p(12)
                  .rounded(8)
                  .bg(t.surface)
                  .border_1()
                  .border_color(t.border)
                  .gap(8)
                  .child(
                    div()
                      .font_weight(600)
                      .text_size(13)
                      .text_color(t.foreground)
                      .child("Prune Stopped Containers")
                  )
                  .child(
                    div()
                      .text_size(12)
                      .text_color(t.muted)
                      .child("Removes all exited and unused containers")
                  )
                  .child(
                    h_flex()
                      .px(10)
                      .py(5)
                      .rounded(6)
                      .bg(t.input)
                      .border_1()
                      .border_color(t.border)
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover))
                      .items_center()
                      .justify_center()
                      .on_click((_e, cx) => this.pruneContainers(cx))
                      .child(div().text_size(12).text_color(t.foreground).child("Run Container Prune"))
                  )
              )
              .child(
                v_flex()
                  .flex_1()
                  .p(12)
                  .rounded(8)
                  .bg(t.surface)
                  .border_1()
                  .border_color(t.border)
                  .gap(8)
                  .child(
                    div()
                      .font_weight(600)
                      .text_size(13)
                      .text_color(t.foreground)
                      .child("Prune Dangling Images")
                  )
                  .child(
                    div()
                      .text_size(12)
                      .text_color(t.muted)
                      .child("Removes untagged / dangling image layers")
                  )
                  .child(
                    h_flex()
                      .px(10)
                      .py(5)
                      .rounded(6)
                      .bg(t.input)
                      .border_1()
                      .border_color(t.border)
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover))
                      .items_center()
                      .justify_center()
                      .on_click((_e, cx) => this.pruneImages(cx))
                      .child(div().text_size(12).text_color(t.foreground).child("Run Image Prune"))
                  )
              )
          )
      )
      .child(
        // Disk Usage Section
        v_flex()
          .flex_1()
          .min_h(0)
          .p(12)
          .rounded(8)
          .bg(t.surface)
          .border_1()
          .border_color(t.border)
          .gap(8)
          .child(
            h_flex()
              .items_center()
              .justify_between()
              .child(
                div()
                  .font_weight(600)
                  .text_size(13)
                  .text_color(t.foreground)
                  .child("Docker System Disk Usage (docker system df)")
              )
              .child(
                div()
                  .cursor_pointer()
                  .text_size(12)
                  .text_color(t.accent)
                  .on_click((_e, cx) => this.fetchSystemDf(cx))
                  .child("Refresh DF")
              )
          )
          .child(
            v_flex()
              .flex_1()
              .min_h(0)
              .p(10)
              .rounded(6)
              .bg(t.input)
              .overflow_y_scrollbar()
              .child(
                div()
                  .text_size(11)
                  .text_color(t.foreground)
                  .child(this.df || "Loading disk usage info...")
              )
          )
      );
  }

  renderInspectModal() {
    if (!this.inspectData) return null;
    const t = theme();
    const c = this.inspectData.container;
    const raw = this.inspectData.raw;

    return div()
      .absolute()
      .inset_0()
      .bg("#000000aa")
      .flex()
      .items_center()
      .justify_center()
      .p(24)
      .child(
        v_flex()
          .w(680)
          .max_h(520)
          .rounded(12)
          .bg(t.popover)
          .border_1()
          .border_color(t.border)
          .child(
            // Modal Header
            h_flex()
              .p(14)
              .border_b_1()
              .border_color(t.border)
              .items_center()
              .justify_between()
              .child(
                h_flex()
                  .gap(8)
                  .items_center()
                  .child(div().text_size(16).child("🔍"))
                  .child(
                    div()
                      .font_weight(700)
                      .text_size(14)
                      .text_color(t.foreground)
                      .child(`Inspect: ${c.Names || c.ID}`)
                  )
              )
              .child(
                div()
                  .cursor_pointer()
                  .p(4)
                  .on_click((_e, cx) => {
                    this.inspectData = null;
                    cx.notify();
                  })
                  .child(div().text_size(14).text_color(t.muted).child("✕"))
              )
          )
          .child(
            // Modal Body: Formatted highlights & JSON
            v_flex()
              .flex_1()
              .min_h(0)
              .p(14)
              .overflow_y_scrollbar()
              .gap(10)
              .child(
                v_flex()
                  .p(8)
                  .rounded(6)
                  .bg(t.surface)
                  .gap(4)
                  .child(
                    div()
                      .text_size(12)
                      .font_weight(600)
                      .text_color(t.accent)
                      .child("Configuration Highlights:")
                  )
                  .child(
                    div()
                      .text_size(12)
                      .text_color(t.foreground)
                      .child(`• State: ${raw?.State?.Status} (Pid: ${raw?.State?.Pid || 0})`)
                  )
                  .child(
                    div()
                      .text_size(12)
                      .text_color(t.foreground)
                      .child(`• Image: ${raw?.Config?.Image || c.Image}`)
                  )
                  .child(
                    div()
                      .text_size(12)
                      .text_color(t.foreground)
                      .child(`• WorkingDir: ${raw?.Config?.WorkingDir || "/"}`)
                  )
                  .child(
                    div()
                      .text_size(12)
                      .text_color(t.foreground)
                      .child(`• IPAddress: ${raw?.NetworkSettings?.IPAddress || "host / bridge"}`)
                  )
              )
              .child(
                v_flex()
                  .p(10)
                  .rounded(6)
                  .bg(t.input)
                  .child(
                    div()
                      .text_size(11)
                      .text_color(t.foreground)
                      .child(JSON.stringify(raw, null, 2))
                  )
              )
          )
      );
  }

  render(cx) {
    const t = theme();
    const isOverlay = Boolean(props()?.overlay);

    const root = div()
      .id("docker-dashboard-root")
      .track_focus(this.handle)
      .on_size_change((size, cx) => {
        const w = Math.round(size.width);
        if (Math.abs((this.panelWidth || 0) - w) >= 6) {
          this.panelWidth = w;
          cx.notify();
        }
      })
      .on_key_down((e) => {
        if (e.key === "escape") {
          if (this.inspectData) {
            this.inspectData = null;
            cx.notify();
          } else {
            this.closeModal();
          }
        }
      })
      .w_full()
      .h_full()
      .bg(isOverlay ? t.popover : t.surface)
      .when(isOverlay, (el) => el.rounded(12).shadow_lg().border_1().border_color(t.border))
      .when(!isOverlay, (el) => el.border_l_1().border_color(t.border))
      .flex()
      .flex_col()
      .child(this.renderHeader())
      .child(this.renderTabs())
      .child(
        this.activeTab === "containers"
          ? this.renderContainersTab()
          : this.activeTab === "images"
          ? this.renderImagesTab()
          : this.renderSystemTab()
      );

    if (this.inspectData) {
      root.child(this.renderInspectModal());
    }

    return root;
  }
}
