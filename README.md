# MiuBot

基于 Pi 内核构建的 QQ 机器人管理平台。

- 运行时：`apps/server`（QQ 官方 Bot、模型调用、会话与工具运行）
- 工作台：`apps/web`（平台、提供商、人格、会话、调试台与设置）
- 复用内核：`packages/{provider,agent,context,plugin,session}`
- 移植来源与模块映射：`docs/10-技术架构/04-Pi移植记录.md`
- 开发约定：`AGENTS.md`

## 开始

### 本地使用

### 部署到服务器

当前管理 API 只接受本机回环访问，直接暴露公网会绕过认证。现状评估、硬阻断与实施顺序见 [deploy.md](deploy.md)；
过渡方案（SSH 隧道，零改动）见其中 §6.4。

## 常见问题与解决方案


## 开发

```bash
npm install --ignore-scripts
npm run generate:model-data   # 生成 provider 模型目录（首次或更新模型数据后）
npm run check                 # 类型检查
npm test                      # 单元测试
```


## License

Miubot 采用 MIT。Pi 的 MIT 许可与版权声明保留在 [LICENSE-Pi](docs/LICENSE-Pi)
