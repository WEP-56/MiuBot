import { Icon } from "./Icon";

type Crumb = { label: string; onClick?: () => void };

type TopbarProps = {
  crumbs?: Crumb[];
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
};

export function Topbar({ crumbs, title, subtitle, actions }: TopbarProps) {
  return (
    <header
      className="h-14 px-5 flex items-center justify-between shrink-0"
      style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-app)" }}
    >
      <div className="flex flex-col">
        {crumbs && crumbs.length > 0 && (
          <div className="flex items-center gap-1.5 text-[12px] text-[var(--text-tertiary)]">
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1.5">
                <span
                  className={c.onClick ? "cursor-pointer hover:text-[var(--text-secondary)]" : ""}
                  onClick={c.onClick}
                >
                  {c.label}
                </span>
                {i < crumbs.length - 1 && <Icon.ChevronRight size={12} />}
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-3">
          <h1 className="text-[16px] font-semibold">{title}</h1>
          {subtitle && (
            <span className="text-[12px] text-[var(--text-tertiary)]">{subtitle}</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">{actions}</div>
    </header>
  );
}
