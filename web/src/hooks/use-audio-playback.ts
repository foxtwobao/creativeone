import { useCallback, useEffect, useRef, type SyntheticEvent } from "react";

export function useAudioPlayback() {
    const playing = useRef<HTMLAudioElement | null>(null);
    useEffect(() => () => { playing.current?.pause(); }, []);
    return useCallback((event: SyntheticEvent) => {
        const audio = event.target;
        if (!(audio instanceof HTMLAudioElement)) return;
        if (playing.current !== audio) playing.current?.pause();
        playing.current = audio;
    }, []);
}
