import { hashPassword } from "../src/auth.ts";

/**
 * 生成管理员口令散列，用于 `MIUBOT_PASSWORD_HASH`。
 *
 * 用法（仓库根目录）：
 *   npm run hash-password --workspace=@miubot/server -- '你的口令'
 *
 * 只打印散列，不写任何文件；口令本身不进入 shell 历史以外的任何地方。
 */
const password = process.argv[2];
if (!password) {
	console.error("用法：npm run hash-password --workspace=@miubot/server -- <口令>");
	process.exit(1);
}
if (password.length < 8) {
	console.error("口令至少 8 位");
	process.exit(1);
}
console.log(await hashPassword(password));
