# 지적(`findings`) 형식 안내

매니저 사수가 `hew submit findings` 로 내는 JSON 파일의 형식이다. 짝이 맞는 예시는 이 폴더의 두 파일이다.

- 코어가 준 작업 묶음 파일 예시: `refs/sasu-batch.example.json`
- 그 묶음에 대한 지적 파일 예시: `refs/findings.example.json`

예시는 형식을 보이는 합성 자료다. 내용은 베끼지 않고, 받은 묶음 파일의 본문만 보고 판정한다.

## 작업 묶음 파일

패킷이 가리키는 `batch-<k>.json` 하나가 이번 일의 전부다. 다른 파일을 찾아 읽지 않는다.

| 칸 | 뜻 |
|---|---|
| `for`, `round`, `batch` | 대상(분석), 회차, 묶음 번호 |
| `code` | 작업 단위 종류(W2~W9). 한 묶음은 한 종류만 담는다 |
| `question` | 이 종류가 묻는 것 한 문장. 단위마다 이 질문에만 답한다 |
| `units[].id` | 작업 단위 id. `<종류>:<대상>` 형식(예: `W3:U-12`, `W2:요구-3`) |
| `units[].target` | 대상 id. 원문 단위(`U-n`), 요구, 화면, 차이, 질문 중 하나 |
| `units[].inputs` | 판정에 쓰는 본문. 인용은 여기에 실린 글에서만 옮긴다 |
| `units[].inputs.previous` | 같은 단위를 직전 회차에도 `issue` 로 판정했을 때만 있다. 아래 설명 |

### `previous`: 직전 지적과 테크니컬 매니저의 답변

반송 뒤 다시 도는 단위에는 `inputs.previous` 가 붙는다.

| 칸 | 뜻 |
|---|---|
| `claim`, `kind` | 직전 회차에 낸 지적의 주장과 종류 |
| `response.response` | 테크니컬 매니저의 답. `fixed`(고쳤다), `rejected`(근거를 들어 그대로 뒀다), `asked`(사람에게 물을 질문으로 올렸다). 답이 없으면 `response` 칸 자체가 없다 |
| `response.reason` | 답의 이유 |
| `response.evidence` | 반박 근거(`unit_id`, `quote`). `rejected` 일 때 있을 수 있다 |

- 단위를 이번 본문으로 다시 판정한다. 답변을 읽고 지적이 풀렸는지 본다. 답변이 근거를 들어 반박했고 그 근거가 맞으면 `ok` 다. 고쳤다고 했으면 고쳐졌는지 본문에서 확인한다.
- `previous` 의 글은 원문이 아니다. 지적의 `evidence.quote` 는 `previous` 가 아니라 `inputs` 의 나머지 본문에서만 옮긴다.

### W7 단위의 변경 항목

W7 단위의 `inputs` 에는 그 화면 또는 변형에 걸린 변경 항목이 구분되어 실린다.

| 대상 | 칸 | 뜻 |
|---|---|---|
| 변형 | `changes_for_variant` | 그 변형에 직접 걸린 변경 |
| 변형 | `changes_for_screen` | 부모 화면 전체에 걸린 변경(모든 변형에 적용된다) |
| 화면 | `changes_for_screen` | 그 화면에 걸린 변경 |
| 화면 | `changes_for_variants` | 그 화면의 모든 변형에 걸린 변경 |

- 눈에 보이는 차이가 이 칸들 어디에도 없을 때만 지적한다. 부모 화면에 걸린 변경으로 설명되는 차이는 지적하지 않는다.

## 지적 파일

최상위는 `findings` 배열 하나다. 공통 틀과 `blocking` 은 코어가 붙인다. 직접 쓰지 않는다.

| 칸 | 형식 | 뜻 |
|---|---|---|
| `id` | `F-n` | 지적 id. 이 파일 안에서 겹치지 않게 1 부터 센다 |
| `work` | 작업 단위 id | 묶음 파일의 `units[].id` 를 그대로 쓴다 |
| `verdict` | `ok`·`issue` | 문제가 없으면 `ok` |
| `kind` | 아래 표 | `issue` 일 때 필수 |
| `claim` | 문장 | `issue` 일 때 필수. 무엇이 문제인지 한 문장 |
| `evidence` | 객체 | 근거. 아래 규칙 |
| `action` | `fix`·`ask`·`drop` | `issue` 일 때 필수. 고치는 방법 |

- 묶음의 모든 단위에 판정이 정확히 하나씩 있어야 한다. 빠지거나 겹치면 제출이 거부된다.
- `action`: `fix` 는 테크니컬 매니저가 고칠 수 있는 것, `ask` 는 원문만으로 정할 수 없어 사람에게 물어야 하는 것, `drop` 은 항목을 지워야 하는 것이다.
- 차단 지적은 `action` 이 무엇이든 먼저 테크니컬 매니저에게 반송된다. 테크니컬 매니저가 원문을 다시 보고 풀 수 있으면 풀고, 반송 상한을 채우고도 남은 지적만 사람에게 질문으로 올라간다. 같은 `kind`·같은 `claim` 의 지적은 질문 하나로 합쳐진다.

## 종류별로 쓸 수 있는 `kind`

| 작업 단위 | 허용되는 `kind` |
|---|---|
| W2 | `unsupported` |
| W3 | `missing`, `wrong_disposition` |
| W4 | `false_confirmed` |
| W5 | `ai_only_behavior` |
| W6 | `operator_row` |
| W7 | `visual_unlisted` |
| W8 | `bad_pairing` |
| W9 | `already_answered` |

## 근거를 어떻게 적어야 차단으로 인정되는가

지적에 근거가 있어야 코어가 차단 지적(`blocking: true`)으로 다룬다. 차단 지적만 테크니컬 매니저에게 반송되고, 반송 상한을 채우고도 남은 것이 사람에게 질문으로 올라간다.

| 단위 | 근거 | 차단으로 인정되는 조건 |
|---|---|---|
| W2~W6, W8, W9 | `evidence.quote` (`evidence.unit_id` 는 원문 단위 id) | 인용이 그 단위의 `inputs` 에 실린 텍스트 어딘가에 실제로 있다 |
| W7 | `evidence.image` (필요하면 `box`) | 이미지 경로가 그 단위의 `as_is` 또는 `to_be` 이다 |

- 인용은 `inputs` 의 글에서 글자 그대로 옮긴다. 대조 전에 양쪽에서 공백·줄바꿈과 Markdown 강조 표시(`**`, `__`, 백틱)를 지운다. 뜻을 풀어 쓴 문장은 인용이 아니다.
- 근거가 없거나 대조에 실패하면 거부되지는 않는다. 코어가 경고(`finding_evidence_unverified`)를 내고 차단하지 않는 참고 사항으로만 저장한다.

## 자주 거부되는 이유

| 코드 | 이유 | 고치는 법 |
|---|---|---|
| `finding_missing` | 묶음의 단위에 판정이 없다 | 빠진 단위마다 `ok` 또는 `issue` 를 낸다 |
| `finding_duplicate` | 한 단위에 판정이 둘 이상이다 | 단위마다 하나만 남긴다 |
| `finding_unknown_work` | 묶음에 없는 단위를 가리킨다 | `work` 를 묶음 파일의 `units[].id` 와 똑같이 쓴다 |
| `finding_incomplete` | `issue` 인데 `kind`·`claim`·`action` 이 없다 | 셋을 모두 채운다 |
| `finding_kind_mismatch` | `kind` 가 그 종류에 맞지 않는다 | 위 표의 허용 `kind` 로 바꾼다 |
| `batch_already_submitted` | 이미 낸 묶음을 다시 냈다 | 이미 통과한 묶음이다. 다시 내지 않는다 |
| `batch_unknown` | 계획에 없는 묶음 번호다 | 패킷의 제출 명령에 적힌 번호를 쓴다 |
| `schema_invalid` | 칸의 모양이나 열거값이 틀렸다(`id` 가 `F-n` 이 아님 등) | 이 문서의 표대로 고친다 |
| `id_duplicate` | 지적 `id` 가 겹친다 | `F-1`, `F-2`, … 로 다시 센다 |
