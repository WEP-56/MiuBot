import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";

/**
 * ZIP 归档读取。
 *
 * 技能导入与插件上传共用这一份实现：解压是「外来字节落成本地文件」的唯一入口，
 * 两套实现必然演化出两套校验，而其中一套迟早会漏掉某条路径检查。
 *
 * 三道防线对应三种真实打法：
 * - **zip slip**：条目名写成 `../../.ssh/authorized_keys`，解压时写到目标目录之外；
 * - **zip bomb**：几十 KB 的包解出几十 GB，把磁盘和内存一起打满；
 * - **重名覆盖**：同一路径出现两次，后一个悄悄盖掉前一个（`flag: "wx"` 之外还要在这里先拦）。
 */

export type ZipEntry = { path: string; bytes: Uint8Array };

export type ZipLimits = {
	/** 归档文件本身的字节上限。 */
	maxArchiveBytes?: number;
	/** 条目数上限（目录条目不计）。 */
	maxFiles?: number;
	/** 所有条目解压后的字节总上限。 */
	maxTotalBytes?: number;
};

const DEFAULT_LIMITS: Required<ZipLimits> = {
	maxArchiveBytes: 20_000_000,
	maxFiles: 2_000,
	maxTotalBytes: 32 * 1024 * 1024,
};

/**
 * 归一化条目路径，不合法直接抛错。
 *
 * ZIP 规范要求 `/`，但 Windows 的打包工具会写 `\`，所以先统一再判断。
 */
function normalizeEntryPath(raw: string): string {
	const name = raw.replace(/\\/g, "/");
	if (!name) throw new Error("ZIP 包含空文件名");
	if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) throw new Error(`ZIP 包含绝对路径：${raw}`);
	const parts = name.split("/");
	if (parts.some((part) => part === ".." || part === ".")) throw new Error(`ZIP 包含无效路径：${raw}`);
	return name;
}

/** 读出归档里所有文件条目。目录条目跳过，解压时由 `mkdir` 按需创建。 */
export function readZip(archive: Uint8Array, limits: ZipLimits = {}): ZipEntry[] {
	const { maxArchiveBytes, maxFiles, maxTotalBytes } = { ...DEFAULT_LIMITS, ...limits };
	if (archive.byteLength === 0) throw new Error("ZIP 文件为空");
	if (archive.byteLength > maxArchiveBytes)
		throw new Error(`ZIP 文件超过 ${Math.round(maxArchiveBytes / 1024 / 1024)} MB`);
	// ZIP 一定以 "PK" 开头。没有签名就直接说「这不是 ZIP」，比让解压器找不到条目
	// 再报一句「ZIP 中没有文件」要准确得多——用户传错文件的可能性远高于传了空包。
	if (!(archive[0] === 0x50 && archive[1] === 0x4b)) throw new Error("不是有效的 ZIP 文件");

	/** 按条目名累积分片；fflate 会分多次回调。 */
	const chunks = new Map<string, Uint8Array[]>();
	let totalBytes = 0;

	const unzip = new Unzip((file) => {
		const name = file.name.replace(/\\/g, "/");
		// 目录条目：只用于表达层级，落盘时不需要。
		if (name.endsWith("/")) return;
		const path = normalizeEntryPath(file.name);
		if (chunks.has(path)) throw new Error(`ZIP 包含重复条目：${path}`);
		if (chunks.size >= maxFiles) throw new Error(`ZIP 条目数超过上限（${maxFiles}）`);
		chunks.set(path, []);

		file.ondata = (error, chunk) => {
			if (error) throw new Error(`解压 ${path} 失败：${error.message}`);
			totalBytes += chunk.byteLength;
			// 增量判断：等全部解完再算，压缩包已经把内存吃掉了。
			if (totalBytes > maxTotalBytes)
				throw new Error(`解压后体积超过上限（${Math.round(maxTotalBytes / 1024 / 1024)} MB）`);
			chunks.get(path)?.push(chunk);
		};
		try {
			file.start();
		} catch {
			throw new Error(`ZIP 使用了不支持的压缩方式：${path}`);
		}
	});
	unzip.register(UnzipInflate);
	unzip.register(UnzipPassThrough);

	try {
		unzip.push(archive, true);
	} catch (error) {
		// fflate 对损坏的归档会抛自己的错误，包装成能直接展示的文案。
		throw error instanceof Error && /ZIP|上限|重复|绝对路径|无效路径/.test(error.message)
			? error
			: new Error(`ZIP 文件损坏或压缩格式不受支持：${error instanceof Error ? error.message : String(error)}`);
	}

	// fflate 对「有 PK 头但中央目录损坏」的输入不会抛错，只会一个条目都读不出来。
	// 所以这句话要同时覆盖「空包」和「坏包」两种情况，别让用户以为自己传了个合法空包。
	if (chunks.size === 0) throw new Error("ZIP 中没有可读取的文件（可能是空包，或文件已损坏）");
	return [...chunks.entries()].map(([path, parts]) => {
		const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const part of parts) {
			bytes.set(part, offset);
			offset += part.byteLength;
		}
		return { path, bytes };
	});
}

/**
 * 找出归档里的「根目录」：把带前缀目录的包（`myplugin/miubot.plugin.json`）剥成平层。
 *
 * 返回 `undefined` 表示没有标记文件；`root` 为空字符串表示标记文件就在根上；
 * `matches` 交给调用方判断——「多个标记文件」在技能里是「一次导入多个技能」，
 * 在插件里是「一次导入多个插件」，报错文案不同，判断不该藏在公共层。
 */
export function findArchiveRoot(
	entries: ZipEntry[],
	markerFile: string,
): { root: string; matches: number } | undefined {
	const matches = entries.filter((entry) => entry.path === markerFile || entry.path.endsWith(`/${markerFile}`));
	if (matches.length === 0) return undefined;
	const path = matches[0]!.path;
	return { root: path === markerFile ? "" : path.slice(0, -markerFile.length - 1), matches: matches.length };
}

/** 按根目录裁剪条目，并返回相对路径。`root` 为空时原样返回。 */
export function entriesUnderRoot(entries: ZipEntry[], root: string): ZipEntry[] {
	if (!root) return entries;
	const prefix = `${root}/`;
	return entries
		.filter((entry) => entry.path.startsWith(prefix))
		.map((entry) => ({ path: entry.path.slice(prefix.length), bytes: entry.bytes }));
}
