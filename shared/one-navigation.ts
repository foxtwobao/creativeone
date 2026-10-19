export type OneNavigation = { v: 1; channel: string; homeUrl: string; rechargeUrl: string };
export type OneNavigationPolicy = { defaults: OneNavigation; productHosts: string[] };
export type OneNavigationConfig = {
    moduleUrl: string;
    policy?: OneNavigationPolicy;
    dedicated?: boolean;
    current?: OneNavigation;
};
