# CLAUDE.md（pokapoka-system 開発指示）

この指示は、このリポジトリで作業する AI（Claude Code など）を対象とする。変更は、対象範囲・作業場所・Git の手順を守って進める。

## 対象範囲

このリポジトリで扱うのは、次の二つである。

- 厨房端末（KDS）画面
- 店内中継サーバー（TableCheck から予約情報を取り込む連携処理と、KDS Web 画面への配信を含む）

上流の予約サイト自体の実装、客席タブレット、管理画面は対象外とする。予約サイトから中継サーバーを経由して KDS へ渡す連携処理は対象に含む。対象外の変更が必要に見える場合は、作業を始めずに確認する。

## 作業場所とワークツリー

### 作業開始前に確認すること

コードまたはドキュメントを編集する前に、1テーマにつき1専用ワークツリーを確保する。既存の同テーマ専用ワークツリーで作業を続ける場合は再利用してよいが、編集前に現在のパス、ブランチ、状態を確認する。パスが想定した補助ワークツリーであり、ブランチがそのテーマ専用で、`git status --short` が空または同じテーマの予期した変更だけであることを確認する。いずれかを確認できない場合は再利用しない。別テーマの作業を同じワークツリーで進めない。

メインワークツリーは `C:\Projects\01_dev\school\pokapoka-system` にあり、`main` の確認用に使う。メインワークツリーで直接編集、コミット、プッシュはしない。

```powershell
Get-Location
git -C C:\Projects\01_dev\school\pokapoka-system worktree list
git branch --show-current
git status --short
```

### 作業ワークツリーを作る

適切な同テーマ専用ワークツリーがない場合、または別テーマの作業を始める場合は、必ず `main` から新しいブランチと専用ワークツリーを作る。小さな変更でも省略しない。ブランチ名は `feature/<内容>`、`fix/<内容>`、`docs/<内容>`、`chore/<内容>` のいずれかとする。ワークツリーのディレクトリ名は、ブランチ名の `/` を `-` に置き換えた名前にする。

```powershell
git -C C:\Projects\01_dev\school\pokapoka-system fetch origin
git -C C:\Projects\01_dev\school\pokapoka-system worktree add -b feature/xxx C:\Projects\dev\pokapoka-worktrees\feature-xxx origin/main
cd C:\Projects\dev\pokapoka-worktrees\feature-xxx
git branch --show-current
```

作業開始後にワークツリーがないことに気づいた場合は、編集を続けず、先にこの手順を完了する。他のワークツリーやブランチの変更は、作業中の可能性があるため触らない。

## 実装と変更の確認

作業ブランチで変更を行い、関連するテストや確認手順を実行する。コミットメッセージは `<type>: <説明>` 形式にする。変更範囲、目的、確認手順を PR に明記する。

```powershell
git status
git diff
```

## PR、レビュー、マージ

`main` 向けの PR は `gh pr create` で作成する。レビュー承認と、CI が設定されている場合のグリーンを確認するまでマージしない。レビューで指摘された変更を反映し、再確認が完了してからマージする。

マージ済みでも、ワークツリーやローカル・リモートブランチの削除は自動で行わない。削除が必要な候補を確認し、削除対象と操作内容をユーザーに提示して、明示的な許可を得てから実行する。

## マージ済みワークツリーの安全な確認

作業開始時や片づけを検討するときは、まずマージ済み候補と各ワークツリーの状態を削除を伴わない確認で調べる。確認だけでは削除しない。

```powershell
git -C C:\Projects\01_dev\school\pokapoka-system fetch origin
git -C C:\Projects\01_dev\school\pokapoka-system branch --merged origin/main
git -C C:\Projects\dev\pokapoka-worktrees\feature-xxx status --porcelain
git -C C:\Projects\01_dev\school\pokapoka-system worktree list
```

次のいずれかに該当するものは、削除候補から外してユーザーに報告する。

- `git -C C:\Projects\dev\pokapoka-worktrees\feature-xxx status --porcelain` が空でなく、未コミットの変更がある
- 未プッシュのコミットや、他セッションが使用中である可能性がある
- ブランチが `origin/main` にマージされていない
- 対象のワークツリー、ローカルブランチ、リモートブランチを特定できない

## 破壊的な操作

ワークツリー、ローカルブランチ、リモートブランチの削除は、マージ済みで変更が残っていなくても破壊的な操作である。対象、削除内容、実行するコマンドを示し、ユーザーが明示的に許可するまで実行しない。`--force`、`branch -D`、`reset --hard`、強制プッシュなども同じ扱いとする。

許可を得た後も、対象のワークツリーから移動してから、変更がないことを再確認する。

```powershell
cd C:\Projects\01_dev\school\pokapoka-system
git worktree remove C:\Projects\dev\pokapoka-worktrees\feature-xxx
git branch -d feature/xxx
git push origin --delete feature/xxx
```

`gh pr merge --delete-branch` はマージとリモートブランチ削除を同時に行うため、使用前に対象と削除範囲の許可を得る。ワークツリーとローカルブランチは別途確認する。手動削除などで管理情報だけが残った場合の `git worktree prune` も削除操作に含め、同じ許可を得てから実行する。

## 禁止事項

- `main` への直接コミットまたは直接プッシュ
- ユーザーの許可がないワークツリー・ブランチの削除
- 他セッションのワークツリーや未コミット変更の上書き、破棄、リセット
- 対象範囲外（上流の予約サイト自体の実装、客席タブレット、管理画面）の変更
