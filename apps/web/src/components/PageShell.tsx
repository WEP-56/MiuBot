import type { ReactNode } from "react";

/**
 * 管理页统一外壳。
 *
 * 之前每个页面各写一套外层容器：宽度 760 / 900 / 980 / 1100 混用，外层背景一半是
 * `bg-black text-white`、一半是 `var(--bg-app)` + `var(--text-main)`，居中更是只有表情包页做了。
 * 结果是「整体偏左 + 各页视觉不齐」，而且浅色主题下这几页仍然是黑底。
 *
 * 这里固定三件事：可滚动的页面容器、居中的内容列、跟随主题的背景与文字色。
 * 页面自己不再写外层容器，只写内容。
 */

/** 内容列宽度上限。用字面量类名，Tailwind 才扫描得到。 */
const WIDTHS = {
	760: "max-w-[760px]",
	900: "max-w-[900px]",
	980: "max-w-[980px]",
	1100: "max-w-[1100px]",
} as const;

/** 纵向间距：各页原本就不一致，保留可选值避免迁移时视觉跳变。 */
const GAPS = { 4: "space-y-4", 5: "space-y-5" } as const;

export type PageShellProps = {
	width?: keyof typeof WIDTHS;
	gap?: keyof typeof GAPS;
	children: ReactNode;
};

export function PageShell({ width = 760, gap = 4, children }: PageShellProps) {
	return (
		<div
			className="flex-1 h-full overflow-y-auto p-7"
			style={{ background: "var(--bg-app)", color: "var(--text-main)" }}
		>
			<div className={`mx-auto ${WIDTHS[width]} ${GAPS[gap]}`}>{children}</div>
		</div>
	);
}
