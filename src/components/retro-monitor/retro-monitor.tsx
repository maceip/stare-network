import { component$, useSignal, $, Slot } from "@qwik.dev/core";

type RetroMonitorProps = {
  title?: string;
};

export default component$<RetroMonitorProps>(({ title }) => {
  const powerOn = useSignal(true);
  const pressed = useSignal<string | null>(null);

  const handlePress$ = $((id: string) => {
    pressed.value = id;
    if (id === "power") {
      powerOn.value = !powerOn.value;
    }
    setTimeout(() => {
      pressed.value = null;
    }, 140);
  });

  return (
    <div class="stare-monitor">
      <div class="stare-monitor-shell">
        <aside class="stare-monitor-side left">
          <div class="stare-monitor-badge">STARE</div>
          <div class="stare-monitor-knob" />
          <div class="stare-monitor-slider" />
          <div class="stare-monitor-slider" />
          <div class="stare-monitor-micro" />
        </aside>

        <section class="stare-monitor-screen">
          <div class="stare-monitor-label">
            {title ?? "STARE 3 / TERMINAL SHELL"}
          </div>
          <div class="stare-monitor-bezel">
            <div
              class={[
                "stare-monitor-glass",
                powerOn.value ? "on" : "off",
              ].join(" ")}
            >
              <div class="stare-monitor-scanlines" />
              <div class="stare-monitor-content">
                {powerOn.value ? (
                  <Slot />
                ) : (
                  <div class="stare-monitor-off">
                    <span class="stare-monitor-pixel" />
                  </div>
                )}
              </div>
              <div class="stare-monitor-glow" />
            </div>
          </div>
        </section>

        <aside class="stare-monitor-side right">
          <div class="stare-monitor-model">
            <span>MK</span>
            <strong>III</strong>
          </div>
          <div class="stare-monitor-lights">
            <span class={powerOn.value ? "lit" : ""} />
            <span />
          </div>
          <div class="stare-monitor-toggle" />
          <button
            class={[
              "stare-monitor-power",
              pressed.value === "power" ? "pressed" : "",
            ].join(" ")}
            onClick$={() => handlePress$("power")}
          >
            POWER
          </button>
        </aside>
      </div>
    </div>
  );
});
