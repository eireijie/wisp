import { useEffect, useState } from "react";
import { fileUrl } from "../api.ts";

// a team's icon shows in many rows at once; each file is fetched once
const loaded = new Map<string, Promise<string>>();
const ready = new Map<string, string>();

function load(id: string): Promise<string> {
  let url = loaded.get(id);
  if (!url) {
    url = fileUrl(id).then((u) => (ready.set(id, u), u));
    url.catch(() => loaded.delete(id));
    loaded.set(id, url);
  }
  return url;
}

/** The address of a team's chosen image. `url` stays null with no image, or one that won't load (the ghosts show instead). */
export function useTeamImage(id: string | null | undefined): { url: string | null; loading: boolean } {
  const [state, setState] = useState<{ id: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!id || ready.has(id)) return;
    let live = true;
    load(id).then(
      (url) => live && setState({ id, url }),
      () => live && setState({ id, url: null }),
    );
    return () => {
      live = false;
    };
  }, [id]);
  if (!id) return { url: null, loading: false };
  const known = ready.get(id);
  if (known) return { url: known, loading: false };
  return state?.id === id ? { url: state.url, loading: false } : { url: null, loading: true };
}
