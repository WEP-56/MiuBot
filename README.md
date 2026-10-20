# MiuBot

基于 Pi 内核改造的 QQ 机器人管理平台。

- 运行时：`apps/server`（建设中）
- 工作台：`apps/web`（建设中）
- 复用内核：`packages/{provider,agent,context,plugin,session}`
- 移植来源与模块映射：`docs/10-技术架构/04-Pi移植记录.md`
- 开发约定：`AGENTS.md`

## 开发

```bash
npm install --ignore-scripts
npm run generate:model-data   # 生成 provider 模型目录（首次或更新模型数据后）
npm run check                 # 类型检查
npm test                      # 单元测试
```

## License

Miubot 采用 MIT。Pi 的 MIT 许可与版权声明保留在 `LICENSE-Pi`。
