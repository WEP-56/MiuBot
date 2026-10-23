import { useEffect, useRef, useState } from "react";

/**
 * 开关。
 *
 * 用 `<button role="switch">` 而不是包一层 `<input type="checkbox">`：原生的方块勾选框在
 * 这套微拟物界面里一直是「没做完」的观感，而 role="switch" 的语义和键盘行为（空格/回车切换）
 * 由浏览器按 ARIA 规范给到，不会比原生控件差。
 *
 * `label` 是可访问名称；视觉文字放在外面（很多地方是「标题在左、开关在右」），
 * 所以不传时请确保外层已有可见文字与 `aria-labelledby` 关联。
 */
type ToggleProps = {
	checked: boolean;
	onChange: (next: boolean) => void;
	disabled?: boolean;
	label?: string;
	className?: string;
};

export function Toggle({ checked, onChange, disabled, label, className }: ToggleProps) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={`relative inline-flex h-[20px] w-[36px] shrink-0 items-center rounded-full px-[2px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
				checked ? "justify-end" : "justify-start"
			} ${className ?? ""}`}
			// 轨道色走主题变量：浅色主题下 #333 的轨道会脏成一块黑斑。
			style={{ background: checked ? "#22c55e" : "var(--border-strong)" }}
		>
			<span className="h-[16px] w-[16px] rounded-full bg-white shadow-sm" />
		</button>
	);
}

export type SelectOption = { value: string; label: string };

/**
 * 下拉选择。
 *
 * 原生 `<select>` 的弹层由操作系统绘制，无法跟随主题；这套界面里它一直是突兀的白底列表。
 * 自绘的代价是**必须自己补齐键盘与 ARIA**——所以这里的焦点始终留在按钮上，
 * 用 `aria-activedescendant` 指向高亮项（WAI-ARIA combobox 的常见做法）。
 */
type SelectProps = {
	value: string;
	options: SelectOption[];
	onChange: (value: string) => void;
	disabled?: boolean;
	/** 可访问名称；外层已有 `<label>` 文字时可以不传。 */
	label?: string;
	placeholder?: string;
	className?: string;
};

export function Select({
	value,
	options,
	onChange,
	disabled,
	label,
	placeholder = "未选择",
	className,
}: SelectProps) {
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const root = useRef<HTMLDivElement>(null);
	const listId = useRef(`select-${Math.random().toString(36).slice(2, 9)}`).current;
	const selected = options.find((option) => option.value === value);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: MouseEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", onPointerDown);
		return () => document.removeEventListener("mousedown", onPointerDown);
	}, [open]);

	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);

	const commit = (index: number) => {
		const option = options[index];
		if (!option) return;
		onChange(option.value);
		setOpen(false);
	};

	const toggle = () => {
		if (disabled) return;
		if (!open) {
			const index = options.findIndex((option) => option.value === value);
			setActive(index < 0 ? 0 : index);
		}
		setOpen(!open);
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
		if (disabled) return;
		if (!open) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				toggle();
			}
			return;
		}
		switch (event.key) {
			case "Escape":
				event.preventDefault();
				setOpen(false);
				break;
			case "ArrowDown":
				event.preventDefault();
				setActive((index) => Math.min(options.length - 1, index + 1));
				break;
			case "ArrowUp":
				event.preventDefault();
				setActive((index) => Math.max(0, index - 1));
				break;
			case "Home":
				event.preventDefault();
				setActive(0);
				break;
			case "End":
				event.preventDefault();
				setActive(options.length - 1);
				break;
			case "Enter":
			case " ":
				event.preventDefault();
				commit(active);
				break;
			case "Tab":
				setOpen(false);
				break;
			default:
				break;
		}
	};

	return (
		<div ref={root} className={`relative ${className ?? ""}`}>
			<button
				type="button"
				role="combobox"
				aria-expanded={open}
				aria-controls={open ? listId : undefined}
				aria-activedescendant={open ? `${listId}-${active}` : undefined}
				aria-label={label}
				aria-haspopup="listbox"
				disabled={disabled}
				onClick={toggle}
				onKeyDown={onKeyDown}
				className="sketch-input flex w-full items-center justify-between gap-2 text-left disabled:cursor-not-allowed disabled:opacity-50"
			>
				<span className={`truncate ${selected ? "" : "text-[#777777]"}`}>{selected?.label ?? placeholder}</span>
				<svg
					aria-hidden="true"
					viewBox="0 0 12 12"
					className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
				>
					<path d="M2 4.5 6 8.5 10 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
				</svg>
			</button>
			{open && (
				<ul
					id={listId}
					role="listbox"
					aria-label={label}
					tabIndex={-1}
					className="absolute left-0 right-0 z-50 mt-1 max-h-64 overflow-y-auto rounded-xl p-1 shadow-xl"
					style={{ background: "var(--bg-subtle)", border: "1px solid var(--border-strong)" }}
				>
					{options.length === 0 && <li className="px-3 py-2 text-[13px] text-[#777777]">没有可选项</li>}
					{options.map((option, index) => (
						<li
							key={option.value}
							id={`${listId}-${index}`}
							role="option"
							aria-selected={option.value === value}
							onMouseEnter={() => setActive(index)}
							onMouseDown={(event) => {
								// 用 mousedown 而不是 click：click 会先触发外层的关闭逻辑。
								event.preventDefault();
								commit(index);
							}}
							className={`cursor-pointer rounded-lg px-3 py-1.5 text-[13px] ${
								index === active ? "text-white" : "text-[#bbbbbb]"
							}`}
							style={index === active ? { background: "var(--bg-active)" } : undefined}
						>
							{option.label}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/**
 * 滑杆。
 *
 * 仍然是原生 `<input type="range">`：键盘步进、触摸、无障碍读数浏览器全都给好了，
 * 自己画一个只会丢功能。这里只换外观（见 index.css 的 `.sketch-slider`），
 * 并用内联渐变画出「已填充」的进度。
 */
type SliderProps = {
	value: number;
	min?: number;
	max?: number;
	step?: number;
	onChange: (value: number) => void;
	disabled?: boolean;
	label?: string;
	className?: string;
};

export function Slider({ value, min = 0, max = 100, step = 1, onChange, disabled, label, className }: SliderProps) {
	const ratio = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
	return (
		<input
			type="range"
			min={min}
			max={max}
			step={step}
			value={value}
			disabled={disabled}
			aria-label={label}
			onChange={(event) => onChange(Number(event.target.value))}
			className={`sketch-slider w-full ${className ?? ""}`}
			style={{
				background: `linear-gradient(to right, #22c55e ${ratio * 100}%, var(--border-strong) ${ratio * 100}%)`,
			}}
		/>
	);
}
