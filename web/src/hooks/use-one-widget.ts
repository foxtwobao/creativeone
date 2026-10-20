import { useEffect } from "react";
import { cloudSession } from "@/services/api/cloud";

export function useOneWidget() {
    useEffect(() => {
        const config = cloudSession?.navigation;
        if (!config || document.getElementById("one-widget-script")) return;
        const script = document.createElement("script");
        script.id = "one-widget-script";
        script.src = new URL("./widget.js", config.moduleUrl).href;
        script.async = true;
        script.crossOrigin = "anonymous";
        script.nonce = document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce || "";
        script.dataset.app = "creativeone";
        script.dataset.position = "bottom-right";
        script.dataset.theme = "auto";
        script.dataset.navigationMode = config.dedicated ? "dedicated" : "public";
        if (config.policy) script.dataset.navigationDefaults = JSON.stringify(config.policy);
        if (config.current) script.dataset.navigation = JSON.stringify(config.current);
        document.head.append(script);
        // The widget owns its document-wide listeners and survives SPA route changes.
    }, []);
}
