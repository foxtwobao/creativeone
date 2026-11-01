import type { ReactNode } from "react";
import styles from "@/layouts/creation-workbench.module.css";

export function ParameterOptions({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: ReactNode; disabled?: boolean }[]; onChange: (value: string) => void }) {
    return <div role="group" aria-label={label} className={styles.parameterGroup}><div className="mb-2 text-xs font-medium">{label}</div><div className="flex flex-wrap gap-1.5">{options.map((option) => <button key={option.value} type="button" aria-pressed={value === option.value} disabled={option.disabled} className={`min-h-8 min-w-12 rounded-lg border px-2 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${value === option.value ? "border-primary bg-primary/10 font-medium text-foreground" : "border-border text-muted-foreground hover:bg-accent"}`} onClick={() => onChange(option.value)}>{option.label}</button>)}</div></div>;
}

