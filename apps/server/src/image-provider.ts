import type { AppConfig, ImageProviderConfig } from "./runtime.ts";

/**
 * 解析 `image_gen` 要用的图像提供商。
 *
 * 只认 `config.tools.imageGen.providerId`：以前是「第一个启用且有 Key 的图像提供商」，
 * 那种隐式选择一旦挑错，表现只是「画出来的东西不对」，几乎没法排查。
 *
 * 四种失败都抛错而不是回退——回退到另一个提供商会让「我明明选了 A，为什么是 B」变成悬案。
 */
export function resolveImageProvider(config: AppConfig): ImageProviderConfig {
	const providerId = config.tools.imageGen.providerId;
	if (!providerId)
		throw new Error("图像生成尚未选择提供商：请在「高级配置 → Tools → 图像生成」里选择或新建一个图像提供商");
	const provider = config.imageProviders.find((item) => item.id === providerId);
	if (!provider) throw new Error(`图像提供商 ${providerId} 已不存在，请在「Tools → 图像生成」里重新选择`);
	if (!provider.enabled) throw new Error(`图像提供商 ${provider.name} 已停用，请启用它或换一个`);
	if (!provider.apiKey) throw new Error(`图像提供商 ${provider.name} 尚未配置 API Key`);
	return provider;
}
