// 个人画布已开放；Agent 和第三方可执行插件待独立接入服务端命令。
export const features = {
    assistant: false,
    video: true,
    canvas: true,
    canvasAgent: false,
    serverAgent: import.meta.env.VITE_SERVER_AGENT_ENABLED === "true",
    canvasPlugins: false,
    originalUi: false,
    imageAdvancedSettings: false,
};
