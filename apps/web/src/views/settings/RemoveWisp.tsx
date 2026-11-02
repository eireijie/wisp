import { useEffect, useState } from "react";
import { Button } from "../../components/ui.tsx";
import { Section } from "./parts.tsx";

/** Only in the desktop app, and only for who the app says may: everything else happens in its own window. */
export function RemoveWispSection() {
  const removal = typeof window !== "undefined" ? window.wispDesktop?.removal : undefined;
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let live = true;
    removal?.available().then(
      (yes) => live && setAvailable(yes),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [removal]);
  if (!available) return null;
  return (
    <Section title="Remove Wisp from this computer" description="Other computers aren't changed. You choose what goes in the next step.">
      <Button variant="danger" onClick={() => void removal?.open()}>
        Remove Wisp…
      </Button>
    </Section>
  );
}
