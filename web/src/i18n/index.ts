import i18n, { type BackendModule } from "i18next";
import { initReactI18next } from "react-i18next";

export type AppLocale = "zh-CN" | "en-US";

const LOCALE_STORAGE_KEY = "infinite-canvas:locale";

const languageBackend: BackendModule = {
    type: "backend",
    read(language, _namespace, callback) {
        const resource = language === "en-US" ? import("./locales/en-US") : import("./locales/zh-CN");
        resource.then(({ default: translation }) => callback(null, translation)).catch((error) => callback(error, false));
    },
};

export const appLocaleReady = i18n.use(languageBackend).use(initReactI18next).init({
    lng: (localStorage.getItem(LOCALE_STORAGE_KEY) as AppLocale) || "zh-CN",
    fallbackLng: "zh-CN",
    supportedLngs: ["zh-CN", "en-US"],
    initAsync: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
});

export function changeAppLocale(locale: AppLocale) {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    return i18n.changeLanguage(locale);
}

export default i18n;
