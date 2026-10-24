const normalize = (text) => text.normalize("NFKC").toLocaleLowerCase("ja").replace(/\s+/g, " ").trim();
const mhz = (hz) => (hz / 1e6).toFixed(5);

// Use explicit frequencies, never infer a route's channels from its D label.
export function resolveRouteSelection(preset, ids, includeCommon = true) {
  const routes = [...new Set(ids)].map((id) => {
    const route = (preset.routes ?? []).find((r) => r.id === id);
    if (!route) throw new Error("路線情報が変わりました。路線を選び直してください。");
    return route;
  });
  const roles = new Map();
  const add = (hz, role) => {
    if (!preset.channels.some((c) => c.frequency_hz === hz))
      throw new Error("必要な周波数がプリセットにありません。プリセットファイルを確認してください。");
    if (!roles.has(hz)) roles.set(hz, new Set());
    roles.get(hz).add(role);
  };
  for (const r of routes) {
    r.voice_hz.forEach((hz, i) => add(hz, `${r.designation} 音声第${i + 1}波`));
    add(r.data_hz, `${r.designation} データ波`);
  }
  if (routes.length && includeCommon)
    for (const c of preset.channels.filter((c) => c.format === "common"))
      add(c.frequency_hz, "旅客一斉情報");
  return {
    routes,
    channels: preset.channels.filter((c) => roles.has(c.frequency_hz)),
    roles,
  };
}

export class RoutePicker {
  constructor(document, apply) {
    this.document = document;
    this.apply = apply;
    this.get = (id) => document.getElementById(id);
    this.dialog = this.get("route-dialog");
    this.catalog = [];
    this.chosen = new Set();
    this.items = [];
    this.blocked = false;
    this.applying = false;
    this.lastApplied = null;
    this.get("route-profile").addEventListener("change", () => this.changeProfile());
    this.get("route-search").addEventListener("input", () => this.filter());
    this.get("route-search-clear").addEventListener("click", () => {
      this.get("route-search").value = "";
      this.filter();
      this.get("route-search").focus();
    });
    this.get("route-common").addEventListener("change", () => this.preview());
    this.get("route-clear").addEventListener("click", () => {
      this.chosen.clear();
      this.syncChecks();
      this.preview();
      this.get("route-search").focus();
    });
    for (const id of ["route-close", "route-cancel"])
      this.get(id).addEventListener("click", () => this.dialog.close());
    this.dialog.addEventListener("cancel", (e) => { if (this.applying) e.preventDefault(); });
    // Search inputs may consume Escape to clear their text. Keep the modal's
    // close behavior consistent from every control, including the search box.
    this.dialog.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.preventDefault();
      if (!this.applying) this.dialog.close();
    });
    this.dialog.addEventListener("close", () => this.get("route-open").focus());
    this.get("route-apply").addEventListener("click", () => this.submit());
  }
  node(tag, text, className) {
    const n = this.document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (className) n.className = className;
    return n;
  }
  setCatalog(catalog) {
    this.catalog = catalog;
    this.lastApplied = null;
  }
  setBlocked(blocked) {
    this.blocked = blocked;
    this.get("route-locked").hidden = !blocked;
    this.get("route-apply").disabled = blocked || this.applying || !this.preset?.routes?.length;
  }
  open(profileId, enabled) {
    if (!this.catalog.length || this.dialog.open) return;
    this.currentCount = enabled.size;
    this.currentProfile = profileId;
    this.get("route-profile").replaceChildren(...this.catalog.map((p) => {
      const option = this.node("option", p.label);
      option.value = p.id;
      return option;
    }));
    this.get("route-profile").value = profileId;
    this.changeProfile();
    const last = this.lastApplied;
    if (last?.profileId === profileId && last.channelIds.length === enabled.size && last.channelIds.every((id) => enabled.has(id))) {
      this.chosen = new Set(last.routeIds);
      this.get("route-common").checked = last.common;
      this.syncChecks();
      this.preview();
    }
    this.dialog.showModal();
    this.get("route-search").focus();
  }
  changeProfile() {
    this.preset = this.catalog.find((p) => p.id === this.get("route-profile").value);
    this.chosen.clear();
    this.get("route-search").value = "";
    this.get("route-error").hidden = true;
    const common = this.preset?.channels.some((c) => c.format === "common");
    this.get("route-common").checked = !!common;
    this.get("route-common").disabled = !common;
    // Only explain the disabled state; the checkbox label covers the rest.
    this.get("route-common-hint").textContent = common ? "" : "このプリセットには割当がありません";
    this.get("route-common-hint").hidden = !!common;
    const routes = [...(this.preset?.routes ?? [])].sort((a, b) => a.line.localeCompare(b.line, "ja") || a.section.localeCompare(b.section, "ja"));
    this.items = routes.map((route) => {
      const item = this.node("li");
      const label = this.node("label", undefined, "route-option");
      const check = this.node("input");
      check.type = "checkbox";
      check.value = route.id;
      const copy = this.node("span", undefined, "route-option-copy");
      const heading = this.node("span", undefined, "route-option-heading");
      heading.append(this.node("strong", route.line), this.node("span", route.designation, "route-designation"));
      copy.append(heading, this.node("span", route.section, "route-section"));
      if (route.note) copy.append(this.node("span", route.note, "route-option-note"));
      check.addEventListener("change", () => {
        check.checked ? this.chosen.add(route.id) : this.chosen.delete(route.id);
        this.get("route-error").hidden = true;
        this.preview();
      });
      label.append(check, copy);
      item.append(label);
      return { item, check, search: normalize(`${route.line} ${route.section} ${route.designation}`) };
    });
    this.get("route-results").replaceChildren(...this.items.map((r) => r.item));
    this.get("route-no-data").hidden = routes.length > 0;
    this.get("route-search").disabled = !routes.length;
    this.get("route-results").hidden = !routes.length;
    this.filter();
    this.preview();
  }
  syncChecks() {
    for (const r of this.items) r.check.checked = this.chosen.has(r.check.value);
  }
  filter() {
    const words = normalize(this.get("route-search").value).split(" ").filter(Boolean);
    let count = 0;
    for (const r of this.items) {
      r.item.hidden = !words.every((w) => r.search.includes(w));
      if (!r.item.hidden) count++;
    }
    this.get("route-result-count").textContent = `${count} 区間を表示`;
    this.get("route-results").hidden = !count;
    this.get("route-no-results").hidden = !!count || !this.items.length;
    this.get("route-query").textContent = this.get("route-search").value;
  }
  preview() {
    this.selection = resolveRouteSelection(this.preset, this.chosen, this.get("route-common").checked);
    const { channels, routes, roles } = this.selection;
    this.get("route-selected-count").textContent = `${routes.length} 区間 · ${channels.length} 波`;
    this.get("route-chosen-empty").hidden = !!routes.length;
    this.get("route-clear").disabled = !routes.length;
    this.get("route-chosen").replaceChildren(...routes.map((r) => {
      const item = this.node("li");
      const copy = this.node("span", `${r.line}（${r.section}）`);
      const remove = this.node("button", "解除");
      remove.type = "button";
      remove.setAttribute("aria-label", `${r.line} ${r.section} の選択を解除`);
      remove.addEventListener("click", () => {
        this.chosen.delete(r.id);
        this.syncChecks();
        this.preview();
        this.get("route-search").focus();
      });
      item.append(copy, remove);
      return item;
    }));
    this.get("route-frequencies").replaceChildren(...channels.map((c) => {
      const item = this.node("li");
      const freq = this.node("bdi", `${mhz(c.frequency_hz)} MHz`);
      item.append(freq, this.node("span", [...roles.get(c.frequency_hz)].join(" / ")));
      return item;
    }));
    this.get("route-effect").textContent = routes.length
      ? `現在の ${this.currentCount} 波を、この ${channels.length} 波に置き換えます。${this.preset.id !== this.currentProfile ? "受信プリセットも切り替わります。" : ""}`
      : "路線・区間を選ぶと、受信する周波数を確認できます。";
    this.get("route-apply").textContent = channels.length ? `この ${channels.length} 波を受信対象にする` : "受信対象に適用";
    this.setBlocked(this.blocked);
  }
  // The modal makes the page announcer inert, so the dialog keeps its own.
  showError(text) {
    this.get("route-error").textContent = text;
    this.get("route-error").hidden = false;
    const announcer = this.get("route-announcer");
    announcer.textContent = "";
    setTimeout(() => { announcer.textContent = text; }, 50);
  }
  async submit() {
    if (this.blocked || this.applying || !this.preset?.routes?.length) return;
    if (!this.chosen.size) {
      this.showError("受信したい路線・区間を1つ以上選択してください。");
      this.get("route-search").focus();
      return;
    }
    this.applying = true;
    this.dialog.setAttribute("aria-busy", "true");
    this.dialog.querySelector(".route-content").inert = true;
    this.get("route-close").disabled = true;
    this.get("route-cancel").disabled = true;
    this.setBlocked(this.blocked);
    try {
      const common = this.get("route-common").checked;
      const preset = this.preset;
      const routeIds = [...this.chosen];
      const selection = resolveRouteSelection(preset, routeIds, common);
      await this.apply(preset, selection);
      this.lastApplied = { profileId: preset.id, routeIds, channelIds: selection.channels.map((c) => c.id), common };
      this.dialog.close();
    } catch (error) {
      this.showError(error.message ?? String(error));
    } finally {
      this.applying = false;
      this.dialog.removeAttribute("aria-busy");
      this.dialog.querySelector(".route-content").inert = false;
      this.get("route-close").disabled = false;
      this.get("route-cancel").disabled = false;
      this.setBlocked(this.blocked);
    }
  }
}
