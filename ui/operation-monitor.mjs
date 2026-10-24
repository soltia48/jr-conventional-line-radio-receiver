// The operation table is independent of the selected audio channel and log view.
const labels = ["遅延 / 在線", "3～9分", "10～19分", "20分以上", "最大遅延", "その列車"];
const count = (value) => (value == null ? "不明" : String(value));
const receivedTime = (value) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "不明";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(date);
};
export class OperationMonitorView {
  constructor(document) {
    this.document = document;
    this.get = (id) => document.getElementById(id);
    this.key = "";
  }
  text(id, value) {
    const node = this.get(id);
    if (node.textContent !== value) node.textContent = value;
  }
  update(snapshot, { channels, enabled, running, replay = false }) {
    const available = channels.some((c) => c.format === "common" && enabled.has(c.id));
    const sources = (snapshot?.channels ?? []).filter((c) => c.status.operation_monitor);
    sources.sort((a, b) => {
      const x = a.status.operation_monitor, y = b.status.operation_monitor;
      return y.last_received_at.localeCompare(x.last_received_at);
    });
    const source = sources[0];
    this.get("operation-content").hidden = !source;
    this.get("operation-empty").hidden = !!source;
    if (!source) {
      this.key = "";
      this.get("operation-rows").replaceChildren();
      this.text("operation-state", available ? "情報待ち" : "受信対象なし");
      this.text("operation-empty-title", available ? "線区別の情報を待っています" : "共用波が受信対象にありません");
      this.text("operation-empty-hint", available
        ? running ? "電文が最後まで届くと表示します。音声を聴きながら受信できます。" : "共用波を含めて受信を開始すると、線区別の情報を表示します。"
        : "チャンネル一覧で共用波（一斉形式）を受信対象にしてください。JR東日本の対応電文を表示します。");
      return;
    }
    const monitor = source.status.operation_monitor;
    let state = "受信済み";
    if (!running) state = `受信停止 · ${state}`;
    if (replay) state = `IQ再生 · ${state}`;
    this.text("operation-state", state);
    this.text("operation-received-time", receivedTime(monitor.last_received_at));
    this.text("operation-received-label", replay ? "最終読取日時（JST）" : "最終受信日時（JST）");
    this.text("operation-source", `${source.config.label} · ${(source.config.frequency_hz / 1e6).toFixed(5)} MHz`);
    this.text("operation-repetitions", `同一内容を ${monitor.receptions} 回受信`);
    const rows = monitor.summary.rows;
    const key = JSON.stringify([source.config.id, rows]);
    if (key === this.key) return;
    this.key = key;
    const element = (tag, value, className) => {
      const node = this.document.createElement(tag);
      if (value !== undefined) node.textContent = value;
      if (className) node.className = className;
      return node;
    };
    const fragment = this.document.createDocumentFragment();
    for (const row of rows) {
      const tr = element("tr");
      const heading = element("th", row.line);
      heading.scope = "row";
      tr.append(heading);
      const values = [`${count(row.delayed)} / ${count(row.on_line)}`,
        ...row.delay_classes.map(count),
        row.max_delay_min == null ? "不明" : `${row.max_delay_min}分`,
        row.train_no ?? "不明"];
      values.forEach((value, i) => {
        const td = element("td");
        const label = element("span", labels[i], "operation-cell-label");
        label.setAttribute("aria-hidden", "true");
        const content = element("span", value, "operation-value");
        if (i === 5) content.dir = "ltr";
        td.append(label, content);
        tr.append(td);
      });
      fragment.append(tr);
    }
    this.get("operation-rows").replaceChildren(fragment);
  }
}
