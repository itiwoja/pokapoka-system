// dist/index.html をリポジトリ直下の kds-next.html へ置く。中継サーバーはビルドせずにこのファイルを配る
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../dist/index.html", import.meta.url));
const to = fileURLToPath(new URL("../../kds-next.html", import.meta.url));
copyFileSync(from, to);
console.log("kds-next.html を更新しました");
