import { useEffect, type MouseEvent } from "react";
import { useOneNavigationStore } from "@/stores/use-one-navigation-store";

let subscribers = 0;
const refresh = () => { useOneNavigationStore.getState().refresh(); };
const visible = () => { if (!document.hidden) refresh(); };
const follow = (key: "homeUrl" | "rechargeUrl") => (event: MouseEvent<HTMLAnchorElement>) => {
    const navigation = useOneNavigationStore.getState().refresh();
    if (navigation) event.currentTarget.href = navigation[key];
    else event.preventDefault();
};
const homeClick = follow("homeUrl"), rechargeClick = follow("rechargeUrl");

export function useOneNavigation() {
    const navigation = useOneNavigationStore(state => state.navigation);
    useEffect(() => {
        if (subscribers++ === 0) {
            window.addEventListener("focus", refresh);
            window.addEventListener("pageshow", refresh);
            document.addEventListener("visibilitychange", visible);
            void useOneNavigationStore.getState().load();
        }
        return () => {
            if (--subscribers === 0) {
                window.removeEventListener("focus", refresh);
                window.removeEventListener("pageshow", refresh);
                document.removeEventListener("visibilitychange", visible);
            }
        };
    }, []);
    return {
        homeLink: { href: navigation?.homeUrl, "aria-disabled": !navigation, onClick: homeClick, onAuxClick: homeClick },
        rechargeLink: { href: navigation?.rechargeUrl, "aria-disabled": !navigation, onClick: rechargeClick, onAuxClick: rechargeClick },
        refresh,
    };
}
