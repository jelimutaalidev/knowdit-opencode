import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { Show, createMemo, createSignal } from "solid-js";

import {
  formatProgressLine,
  isKnowditProgress,
  latestProgress,
  removeProgress,
  upsertProgress,
  type ProgressEntry,
} from "./src/progress-events.ts";

/**
 * A single line above the composer that follows KNOWDIT's build progress in
 * this session. It reads the same updates the server tools send to
 * `ctx.progress`, and disappears as soon as the tool finishes.
 */
function KnowditStatus(props: {
  sessionID: string;
  entries: () => readonly ProgressEntry[];
}) {
  const context = usePlugin();
  const line = createMemo(() => {
    const entry = latestProgress(props.entries(), props.sessionID);
    return entry ? formatProgressLine(entry.metadata) : null;
  });

  return (
    <Show when={line()}>
      <box
        width="100%"
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={2}
        paddingRight={2}
      >
        <box flexDirection="row" gap={1} flexShrink={1}>
          <text fg={context.theme.text.feedback.warning.base}>●</text>
          <text fg={context.theme.text.muted}>KNOWDIT</text>
          <text fg={context.theme.text.base} truncate>
            {line()!.detail}
          </text>
        </box>
        <Show when={line()!.percent !== null}>
          <text fg={context.theme.text.muted}>{line()!.percent}%</text>
        </Show>
      </box>
    </Show>
  );
}

export default Plugin.define({
  id: "knowdit.tui",
  setup(context) {
    const [entries, setEntries] = createSignal<readonly ProgressEntry[]>([]);
    let seq = 0;

    const stopProgress = context.data.on("session.tool.progress", (event) => {
      const metadata = event.data.metadata;
      if (!isKnowditProgress(metadata)) return;

      seq += 1;
      setEntries((current) =>
        upsertProgress(current, {
          toolID: event.data.id,
          sessionID: event.data.sessionID,
          metadata,
          seq,
        }),
      );
    });

    const clear = (toolID: string) => {
      setEntries((current) => removeProgress(current, toolID));
    };
    const stopSuccess = context.data.on("session.tool.success", (event) => clear(event.data.id));
    const stopFailed = context.data.on("session.tool.failed", (event) => clear(event.data.id));

    const unclaim = context.ui.slot({
      append: "session.composer.top",
      render: (input) => <KnowditStatus sessionID={input.sessionID} entries={entries} />,
    });

    return () => {
      stopProgress();
      stopSuccess();
      stopFailed();
      unclaim();
    };
  },
});
