import { App } from "antd";
import { saveAs } from "file-saver";

export function useDownloadFile() {
    const { message } = App.useApp();
    return async (url: string, filename: string) => {
        try {
            const response = await fetch(url, { credentials: "same-origin" });
            if (!response.ok) throw new Error("下载失败，请稍后重试");
            saveAs(await response.blob(), filename);
            message.success("下载已开始");
        } catch (error) { message.error(error instanceof Error ? error.message : "下载失败"); }
    };
}
