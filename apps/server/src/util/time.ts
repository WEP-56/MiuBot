/** 本机时区的日期键（`YYYY-MM-DD`），用于按天统计主动发言额度。 */
export function localDateKey(date = new Date()): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
