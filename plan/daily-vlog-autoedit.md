# 元気さん「プロゲーマーの日常」フォーマットの自動編集

## Context

ある方（元気さん）から動画の自動編集を継続的に依頼されている。編集スタイルは毎回完全に同一で、渡される素材だけが毎回違う。今回渡されたのは「1日ぶんのテイクを全部1本に結合した長尺ファイル」2本（1080×1920 HEVC・6分32秒／7分13秒）。仕上がりの手本はサンプル5本（50〜129秒）。

「専用AIモデルを毎回学習させる」必要はない。**Editable は既にこの用途のためのエンジンそのもの**であり、必要なのは (1) この編集スタイルを `formats/` に1個の JSON として記述すること、(2) 「可変個数のシーンを長尺素材から発見する」という、既存フォーマットに無い1ステージを本体に足すこと — この2点だけ。1本目が通れば、同系フォーマットは設定ファイル追加だけで増やせる。

### サンプル解析でわかった編集仕様（実測）

| 項目 | 実測値 |
|---|---|
| 尺 | 50〜129秒（中央値 ~63秒） |
| カット数 / 平均ショット長 | 24カット / 50秒 → **約2.1秒**。大半が1〜3秒、稀に5秒 |
| 音 | **BGM・SFXなし**。原音そのまま（スペクトログラムに完全無音区間が存在） |
| 冒頭タイトル | 3行・白・太ゴシック（非斜体）・センター・y中心 ≈ 0.53・font-size ≈ 幅の 8.9% |
| 時刻テロップ | 白・**斜体**・センター・y ≈ 0.574・font-size ≈ 幅の 6.4%（例 `15:30`） |
| 説明テロップ | 白・**斜体**・センター・1行目 y ≈ 0.633・font-size ≈ 幅の 5.6%・line-height ≈ 1.35・最大2行 |
| 共通 | 全カットに「時刻＋説明」がブロック全尺で出っぱなし。ドロップシャドウあり |

### 素材側の制約（重要）

結合済み1本の `creation_time` は**結合した時刻**しか持たず、各テイクの撮影時刻は失われている。ユーザー決定により、**時刻テロップは LLM が内容・順番・画面内の時計から推定し、エディタで手直しする**方針とする（生素材には時計オブジェクトが写り込むカットがあり、視覚的に読める場面はそれを優先する）。

### 決定事項

- 時刻: 結合1本のまま AI 推定（+ 画面内時計の読み取り、エディタで修正）
- 音: サンプル通り原音のみ（BGM / SFX なし）
- スコープ: 日常vlogフォーマット1本を通しで（素材投入 → 書き出しまで）

---

## 既存資産（新規に書かないもの）

このフォーマットに必要な部品はほぼ全部ある。**再実装しないこと。**

| やりたいこと | 既にあるもの |
|---|---|
| 長尺1本 → 各ブロックの区間に分割 | `src/backend/pipeline/splitTake.ts` の `SplitTakeResult` / `TakeSplit` 型と `deriveTranscriptAndTrim()`。**1ブロックに複数 `TakeSplit` を渡すと自動で連結される**（`splitMultiClipTake` 用の既存機構）→「一文が2テイクに割れている」ケースがそのまま表現できる |
| ショット境界の検出＋代表フレーム抽出 | `src/backend/authoring/analyze.ts`（ffmpeg scene detect、`SCENE_THRESHOLD`、`DENSE_CHANGE_THRESHOLD`、フレーム書き出し、`downsampleEvenly`） |
| フレームを添えた構造化 LLM 呼び出し | `src/backend/authoring/synthesize.ts` の `Anthropic.ImageBlockParam` + `zodOutputFormat` パターン |
| 無音区間・発話区間 | `src/backend/pipeline/trim.ts` の `detectSilenceIntervals()` |
| 日本語書き起こし | `src/backend/pipeline/whisper.ts` の `transcribeFile(path, workDir, "ja")` |
| テロップ描画 | `src/backend/remotion/components/TextOverlay.tsx`（`italic` / `fontFamily` / `fontWeight` / `TEXT_SHADOW` を既にサポート） |
| 日本語フォント | `public/fonts/noto-sans-jp-{400,500,700,900}`、`src/backend/remotion/fonts.ts` の `NOTO_SANS_JP_FONT`、改行は `src/backend/components/cjk.ts` の `splitIntoUnits` |
| 「ブロック全尺で出しっぱなし」の指定 | `timing: { kind: "fixed", anchor: "blockStart", offsetSec: 0 }` + `durationSec` 省略（= ブロック終端まで） |
| 人手の修正 UI | resources ウィザード Step 3 の分割ハンドル（`confidence < 0.5` を要確認として強調）＋ `/jobs/[jobId]/edit` の NLE |
| 書き出し | `assemble.ts` → `EdlVideo.tsx` → `render.ts` |

---

## 実装

### 1. 可変個数ブロックの表現 — `repeat` ブロック

`FormatSchema` は `blocks` が**オーサリング時に固定**という前提。vlog は日によってシーン数が変わるので、テンプレートを1個だけ書いて実行時に N 個へ展開する。

**`src/backend/pipeline/schemas.ts`**
- `BlockSchema` に `repeat: z.boolean().default(false)` を追加 — 「このブロックは雛形。discover ステージが 0..N 個に複製する」の意。`blocks.min(1)` も既存の superRefine も無傷。
- `FormatEventSchema` に `repeatScope: z.enum(["all", "first", "last"]).default("all")` を追加 — 冒頭タイトルを「クローン0番だけ」に出すため。
- `FormatSchema` に `discovery` を追加（省略可、`repeat: true` のブロックがある時のみ必須）:
  ```
  discovery: {
    minBeats, maxBeats, minBeatSec, maxBeatSec, targetTotalSec,
    prompt: string,          // このフォーマット固有の「何を1シーンとみなすか」の指示
    beatFields: string[]     // LLM に返させる per-beat フィールド名（例 ["clockTime","caption"]）
  }
  ```
  → **エンジンはフォーマットごとに変わらない**という既存の原則を守ったまま、別ニッチのフォーマットも `discovery.prompt` の差し替えだけで追加できる。

**`src/backend/pipeline/expandFormat.ts`（新規、~120行）**
`(format, discovered) => Format` の純関数。`repeat: true` のブロックを `beat-01..beat-NN` に複製し、`videoSlot` / `slots[].name` / `events[].id` に連番を振り、各クローンのイベント `params` に discover が出したテキスト（`clockTime`, `caption`）を差し込み、`repeatScope` に合う位置のクローン以外から該当イベントを落とす。`loader.ts` の `withImplicitSpeakingTake` と同じ「検証前後にフォーマットを機械変換する」既存の書き方に揃える。

### 2. discover ステージ（新規）

**`src/backend/pipeline/discover.ts`（新規、~300行）**

`(format, filled, jobId) => DiscoverResult`

1. `speakingTakeSlot` に束ねられた長尺ファイルを取る。
2. **ショット候補**: `analyze.ts` のシーン検出＋代表フレーム抽出ロジックを共有ヘルパへ切り出して再利用（`analyze.ts` 側は呼び出しに置換）。scene threshold は生素材で実測 40カット@0.15 / 18カット@0.4 → **0.2 前後を初期値**とし、無音区間との論理和で境界を補う（映像が似ていても録画が切れていれば音が切れる）。
3. `detectSilenceIntervals()` で発話区間、`transcribeFile(..., "ja")` で単語タイムスタンプ（**1回だけ**走らせて全ステージで使い回す）。
4. **1回の Anthropic マルチモーダル呼び出し**（`synthesize.ts` と同じ形。フレーム + 各ショットの書き起こし + 尺 + `discovery.prompt`）で、`zodOutputFormat` により以下を構造化取得:
   - `keep: boolean` — 採用/不採用
   - `retakeGroupId` — 撮り直しの束。同じ `retakeGroupId` の中から**最後の1本**を既定採用（撮り直しは後のテイクが良い、が LLM が明示的に best を指定したらそれを優先）
   - `mergeWithPrevious: boolean` — 一文が次テイクへ跨っている場合
   - `orderIndex` — 時系列順
   - `clockTime: "H:MM"` — 画面内の時計が読めればその値、読めなければ内容と順番からの推定
   - `caption: string` — 説明テロップ（最大2行、サンプルの語調に合わせる）
   - `srcInSec` / `srcOutSec` — LLM のラフ値を、コード側で発話区間＋`PAD_SEC` に**必ずスナップ**して確定させる（LLM の秒数は直接信用しない）
5. **コード側の後処理（決定的）**:
   - `clockTime` を単調非減少に強制（逆行したら直前値へクランプ）
   - 各ビートを `discovery.minBeatSec..maxBeatSec` にクランプ
   - `mergeWithPrevious` のショットは前ビートに**2個目の `TakeSplit`** として付ける（連結は `deriveTranscriptAndTrim` が既にやる）
   - 合計尺が `targetTotalSec` を超える場合、LLM の重要度スコア降順で末尾から間引く
6. 出力: `artifacts/<job>/discovered.json`、**および `splitTake.json`（既存 `SplitTakeResult` 形式）**。後者を書くことで `buildJob` の `readSplit(jobId) ?? runSplit(...)` がそのまま拾い、`deriveTranscriptAndTrim` 以降は**一切変更不要**で通る。これは `splitTake.ts` の doc comment が明言している設計意図そのもの。

### 3. orchestrate への配線

**`src/backend/pipeline/orchestrate.ts`** の `buildJob`（現在 156-198行目あたり）:

```
const intakeFilled = intake(jobDir);              // pass 1: 雛形ブロック1個のまま
const baseFormat = loadFormat(intakeFilled.formatId);
// ↓ 追加
const discovered = hasRepeatBlock(baseFormat)
  ? (readArtifact(jobId, "discovered") ?? await discover(baseFormat, intakeFilled, jobId))
  : null;
const format = discovered ? expandFormat(baseFormat, discovered) : baseFormat;
writeArtifact(jobId, "format", format);           // reassembleJob はこれを読む
const filled0 = discovered ? intake(jobDir, format) : intakeFilled;  // pass 2: 各 beat へ take をクローンイン
```

- **`intake(jobDir)` に第2引数 `format?: Format` を追加**（`src/backend/pipeline/intake.ts:237`）。省略時は今まで通り内部で `loadFormat` する。展開後フォーマットを渡すことで、既存の `derivedFromTake` クローンイン（440-460行目付近）が全 beat ブロックの `videoSlot` を埋める。
- **`reassembleJob`（238行目）と `readOrMigrateEdl`** は `loadFormat` ではなく `artifacts/<job>/format.json` を優先して読む。無ければ従来通り。これでエディタの「イベント時刻を微調整して再アセンブル」が展開後フォーマットに対して効く。
- `generate` / `matte` / `backgroundReplace` / `resolveRoles` はこのフォーマットでは全て no-op（generation spec 無し、`roles`/`anchors` 空）。分岐追加は不要。

### 4. フォーマット定義

**`formats/daily-vlog-timeline.json`（新規）**

```
id/name/niche: "daily-vlog-timeline" / "プロゲーマーの日常" / vlog
fps 30, width 1080, height 1920            ← 生素材と同解像度（不要なダウンスケールをしない）
speakingTakeSlot: { name:"dayFootage", mediaType:"video", required:true,
                    label:"その日の素材（結合1本でOK）" }
musicSlot: なし / captionStyle: なし        ← 原音のみ・発話キャプション無し
discovery: { minBeats:12, maxBeats:45, minBeatSec:1.2, maxBeatSec:5.0,
             targetTotalSec:75, prompt:"…", beatFields:["clockTime","caption"] }
blocks: [ { id:"beat", kind:"voice", repeat:true, captions:false,
            videoSlot:"beatClip", slots:[…],
            events:[ title, beatTime, beatCaption ] } ]
```

イベント3種（すべて `TextOverlay`、`timing: {kind:"fixed", anchor:"blockStart", offsetSec:0}`、`durationSec` 省略＝ブロック終端まで）:

| id | repeatScope | layout (フレーム比) | スタイル |
|---|---|---|---|
| `title` | `first` | x 0.5 / y中心 0.53 / width 0.86 | Noto Sans JP 700・**非斜体**・fontSize 0.089w・3行・center |
| `beatTime` | `all` | x 0.5 / y 0.574 / width 0.8 | Noto Sans JP 500・**italic**・fontSize 0.064w |
| `beatCaption` | `all` | x 0.5 / y 0.633 / width 0.84 | Noto Sans JP 500・**italic**・fontSize 0.056w・lineHeight 1.35・最大2行 |

すべて `TEXT_SHADOW` あり。改行は `cjk.ts` の `splitIntoUnits` で禁則を守る。

> Noto Sans JP に真の italic フェイスは無く、Chromium が合成オブリークを描く。サンプル側も合成オブリークなので**見た目は一致する**。

### 5. UI 側の最小追加

- `src/app/lib/formats.ts` の `FormatSummary`: `repeat` ブロックがあるフォーマットは「必要スロット = 長尺1本だけ」と表示する（現在はブロック数からスロットを数えている）。
- resources ウィザード Step 3（分割 UI）は展開後の N ビートをそのまま表示する。**各ビートの `clockTime` / `caption` をその場で編集できるテキスト欄を追加**（推定の手直し導線。ここが今回の方針で一番効く UI）。編集内容は job.json の overrides に入れ、`reassembleJob` で反映。

---

## 触るファイル

| ファイル | 変更 |
|---|---|
| `src/backend/pipeline/discover.ts` | **新規** — ショット発見・テイク選別・時刻/テロップ生成 |
| `src/backend/pipeline/expandFormat.ts` | **新規** — `repeat` ブロックの N 個展開 |
| `formats/daily-vlog-timeline.json` | **新規** — フォーマット定義 |
| `src/backend/pipeline/schemas.ts` | `BlockSchema.repeat` / `FormatEventSchema.repeatScope` / `FormatSchema.discovery` / `DiscoverResultSchema` |
| `src/backend/pipeline/orchestrate.ts` | `buildJob` に discover→expand を挿入、`reassembleJob`/`readOrMigrateEdl` は `artifacts/<job>/format.json` 優先 |
| `src/backend/pipeline/intake.ts` | `intake(jobDir, format?)` の第2引数 |
| `src/backend/authoring/analyze.ts` | シーン検出＋フレーム抽出を共有ヘルパへ切り出し（機能変更なし） |
| `src/app/lib/formats.ts`, resources ウィザード Step 3 | 長尺1本UI と 時刻/テロップ編集欄 |

`assemble.ts` / `EdlVideo.tsx` / `TextOverlay.tsx` / `render.ts` / `timelineOps.ts` / エディタ本体は**無変更**。

---

## 検証

1. **フォーマット単体**: `npx tsx -e` で `loadFormat("daily-vlog-timeline")` が通ること、`expandFormat` にダミー discovered（3ビート）を食わせて `FormatSchema.parse` が再度通ること。
2. **実素材で通し**:
   ```
   jobs/vlog-genki-01/ に job.json（format: daily-vlog-timeline）を作り
   assets/ に 'タイトルなし.mp4' を dayFootage として束ねる
   npm run pipeline -- --job jobs/vlog-genki-01
   ```
   `artifacts/vlog-genki-01/` の `discovered.json` → `splitTake.json` → `edl.json` を順に目視。
3. **discover の質を数値で確認**（サンプル実測値が合格ライン）:
   - ビート数 25〜40、平均ビート長 **1.8〜2.5秒**、合計 50〜130秒
   - `clockTime` が単調非減少で、生素材に時計が写るカット（例 10:16 / 10:36 / 10:56 の球体時計）で実際の表示と一致すること
   - 撮り直しペアが `retakeGroupId` で束ねられ、採用が1本だけになっていること
4. **書き出しと突き合わせ**: `npm run pipeline -- --job jobs/vlog-genki-01 --only render` → `out/vlog-genki-01.mp4`。サンプル動画と並べて、テロップの位置・サイズ・斜体・シャドウ、タイトルの行数と大きさを 1:1 で確認する（同じ `ffmpeg crop` で切り出して比較すると差が見やすい）。
5. **エディタ経路**: `npm run app:dev` → `/jobs/vlog-genki-01/edit` を開き、分割ハンドルでビート境界を、Step 3 の欄で `clockTime` / `caption` を直し、再アセンブル後も EDL が壊れないこと。
6. **2本目で汎化確認**: `'タイトルなし(2).mp4'` を新規ジョブで同じフォーマットに通し、コードもフォーマットも一切触らずに同等の仕上がりになること。これが「どのようなクリップでも対応できる」の合格条件。

---

## 正直な見積もり

- **カット割り・テイク選別・テロップ文言**は素材内に答えがあるので、高い精度で自動化できる見込み。
- **時刻テロップだけは推定**なので、初回は数カット手直しが要る前提。もし後日「結合前の個別クリップ」を貰えるようになれば、各ファイルの `creation_time` から時刻・並び順・カット境界が**全部確定値**になり、discover の LLM 依存が大きく減る。フォーマットも本体も変えずに discover の入力が増えるだけなので、後から差し込める。
