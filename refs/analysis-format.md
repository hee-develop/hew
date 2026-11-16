# 분석 문서(`analysis`) 형식 안내

`hew submit analysis` 로 내는 JSON 파일의 형식이다. 최상위는 `items` 가 아니라 아래 일곱 묶음을 바로 가진 객체다(공통 틀은 코어가 씌운다). 정확한 예시는 이 폴더의 두 파일이다.

- 통과하는 분석 문서 예시: `refs/analysis.example.json`
- 그 예시가 가리키는 원문 단위 목록: `refs/analysis.example.units.json`

예시는 실제 일감의 내용이 아니라 형식을 보이는 합성 자료다. 칸의 모양과 id 쓰는 법만 따르고 내용은 베끼지 않는다.

## 쓰는 규칙

- 아래 표에 없는 칸을 만들지 않는다. 스키마에 없는 키는 코어가 버리고 경고를 낸다.
- 표의 "필수" 는 스키마가 요구하는 칸이다. "검사" 는 칸 자체는 비워도 되지만 결정적 검사가 채우라고 요구하는 경우다. "선택" 은 비워도 된다. 목록 칸은 비우면 `[]` 다.
- id 형식: 화면 `화면-n`, 변형 `화면-n.m`(앞부분이 소속 화면 id 와 같아야 한다), 요구 `요구-n`, 인수 조건 `요구-n/AC-k`(앞부분이 소속 요구 id 와 같아야 한다), 질문 `Q-n`, 차이 `D-n`, 가정 `A-n`, 범위 장부 행 `C-n`, 영향 영역 `I-n`, 막힘 `B-n`. n 은 1 부터 시작하는 숫자다. 영문 `REQ-1` 같은 라벨은 거부된다. 원천 `S-n`, 원문 단위 `U-n` 은 코어가 붙인 것을 그대로 쓴다.
- 같은 종류의 id 를 두 번 쓰지 않는다. 재제출에서는 같은 항목이 같은 id 를 유지한다.

## 사람이 채우는 칸은 비워 둔다

다음 칸은 사람이 게이트에서 채운다. 에이전트가 값을 넣어 내도 코어가 버리고 경고(`human_field_ignored`)를 낸다. 처음부터 쓰지 않는다.

| 묶음 | 칸 | 채우는 사람의 입력 |
|---|---|---|
| `deltas[]` | `decision` | `follow_figma`, `follow_prd`, `drop`, `hold` 중 차이 종류에 허용되는 값 |
| `questions[]` | `answer` | 선택지 키 또는 자유 답 |
| `assumptions[]` | `status` | `confirmed`, `rejected` |

추천(`deltas[].recommendation`, `questions[].recommended`)은 사람의 답이 아니다. 추천을 적어도 그 항목은 열린 채로 남는다.

## 근거(evidence)의 두 형태

근거는 항상 원문 단위 id 를 가리킨다. 두 형태 중 하나다.

| 형태 | 칸 | 쓰는 때 |
|---|---|---|
| 인용 | `{ "unit_id": "U-41", "quote": "원문에서 그대로 옮긴 문장" }` | 글로 된 원문(PRD, 티켓, 설명 카드) |
| 이미지 | `{ "unit_id": "U-6", "image": "sources/figma/s1.png", "box": { "x": 0, "y": 0, "w": 10, "h": 10 } }` | 시안이 근거일 때. `box` 는 선택 |

- 인용은 그 단위의 본문에 실제로 있어야 한다. 대조 전에 양쪽에서 공백·줄바꿈과 Markdown 강조 표시(`**`, `__`, 백틱)를 지운다. 뜻을 풀어 쓴 문장은 인용이 아니다.
- 이미지 근거의 `image` 는 그 단위의 이미지이거나 실행 폴더에 있는 파일이어야 한다.
- `actor` 가 운영자(`operator`)인 단위는 근거로 쓸 수 없다. 작업 구분 표의 Mobile(App) 열에 앱 요소가 적혀 있으면 예외다.

## 최상위

| 묶음 | 형식 | 필수 | 뜻 |
|---|---|---|---|
| `screens` | 객체 배열 | 필수 | 화면과 상태 변형 |
| `requirements` | 객체 배열 | 필수 | 요구 |
| `deltas` | 객체 배열 | 필수 | PRD–시안 차이 |
| `questions` | 객체 배열 | 필수 | 질문 |
| `assumptions` | 객체 배열 | 필수 | 가정 |
| `coverage` | 객체 배열 | 필수 | 범위 장부 |
| `impact` | 객체 | 필수 | 코드 수준 영향과 막힘 |

## screens[] — 화면

| 칸 | 형식 | 필수 | 뜻 |
|---|---|---|---|
| `id` | `화면-n` | 필수 | 화면 id |
| `name` | 문자열 | 필수 | 사람이 읽는 이름 |
| `change` | `new`·`changed`·`removed`·`reference` | 필수 | 새 화면, 바뀜, 제거, 바뀌지 않지만 참고 |
| `figma` | 객체 `{ file_key?, node_id?, url? }` | 선택 | 시안 위치 |
| `images` | 배열 `{ role, path, hash? }` | 선택 | 화면 이미지. `role` 은 `as_is`·`to_be`·`both`, `path` 는 스냅샷 경로 |
| `variants` | 배열 `{ id, name, images }` | 선택 | 상태 변형. `id` 는 `화면-n.m`. 변형을 별도 화면으로 펼치지 않는다 |
| `code` | 객체 `{ name?, path? }` | 선택 | 이 화면에 해당하는 코드의 화면 이름과 경로 |

시안이 있는 일감에서는 모든 화면에 이미지를 붙인다(없으면 `screen_without_image` 경고).

## requirements[] — 요구

| 칸 | 형식 | 필수 | 뜻 |
|---|---|---|---|
| `id` | `요구-n` | 필수 | 요구 id |
| `title` | 문자열 | 필수 | 한 줄 제목 |
| `status` | `confirmed`·`pending` | 필수 | 확정 / 열린 질문·차이·가정에 걸림 |
| `screen_ids` | 문자열 배열 | 선택 | 첫 번째가 대표 화면. 비면 화면에 묶이지 않은 요구 |
| `changes` | 배열 | 검사 | 변경 항목. 항목 하나가 변경 하나 |
| `acceptance` | 배열 | 검사 | 인수 조건. 요구마다 하나 이상 |
| `ai` | 객체 | 선택 | AI용 칸(아래 표) |
| `depends_on` | 요구 id 배열 | 선택 | 먼저 끝나야 하는 요구 |

`changes[]`

| 칸 | 형식 | 필수 | 뜻 |
|---|---|---|---|
| `text` | 문자열 | 필수 | 사람이 읽는 짧은 문장 |
| `screen_id` | 화면 또는 변형 id | 선택 | 이 변경의 자리 |
| `evidence` | 근거 배열 | 검사 | 하나 이상 필요 |

`acceptance[]`

| 칸 | 형식 | 필수 | 뜻 |
|---|---|---|---|
| `id` | `요구-n/AC-k` | 필수 | 인수 조건 id |
| `given` | 문자열 | 선택 | 전제 |
| `when` | 문자열 | 필수 | 하는 일 |
| `then` | 문자열 | 필수 | 기대 결과 |
| `verify` | 객체 `{ method, detail? }` | 검사 | 검증 수단. `method` 는 `unit_test`·`type_check`·`qa_scenario`·`visual_compare`·`review` |

`ai` (AI용 칸. 새 동작이나 조건을 담지 않는다)

| 칸 | 형식 | 필수 | 뜻 |
|---|---|---|---|
| `code` | 배열 `{ path, symbol?, role }` | 선택 | 코드 위치. `role` 은 `modify`·`reuse`·`reference`. `modify`·`reuse` 의 `path` 는 대상 저장소에 있어야 한다 |
| `verify` | 배열 `{ ac_id, detail }` | 선택 | 인수 조건 id 와 그것을 확인하는 구체적 방법 |
| `rules` | 문자열 배열 | 선택 | 적용할 규칙 id |
| `notes` | 배열 `{ text, evidence }` | 선택 | 보충. `evidence` 가 비면 거부된다 |

## deltas[] — PRD–시안 차이

| 칸 | 형식 | 필수 | 뜻 |
|---|---|---|---|
| `id` | `D-n` | 필수 | 차이 id |
| `title` | 문자열 | 필수 | 제목 |
| `kind` | `figma_only`·`prd_only`·`mismatch` | 필수 | 시안에만 있음 / PRD 에만 있음 / 둘이 다름 |
| `requirement_ids` | 요구 id 배열 | 선택 | 첫 번째가 대표 요구 |
| `comparison` | 객체 `{ prd_source?, figma_source?, rows }` | 선택 | 비교 표. `rows` 는 `{ aspect, prd?, figma? }` 배열. 같은 조건·같은 대상일 때만 한 행에 두고 짝이 없으면 비운다 |
| `prd_evidence` | 근거 배열 | 선택 | PRD 쪽 근거 |
| `figma_evidence` | 근거 배열 | 선택 | 시안 쪽 근거 |
| `audience` | `dev`·`po`·`designer`·`backend` 배열 | 선택 | 누가 판단하나 |
| `recommendation` | 객체 `{ decision, reason? }` | 선택 | 추천. `decision` 은 이 `kind` 에 허용되는 값이어야 한다 |
| `decision` | — | 사람의 칸 | 쓰지 않는다 |

종류별 허용 결정: `figma_only` 는 `follow_figma`·`drop`·`hold`, `prd_only` 는 `follow_prd`·`drop`·`hold`, `mismatch` 는 `follow_figma`·`follow_prd`·`drop`·`hold`.

## questions[] — 질문

| 칸 | 형식 | 필수 | 뜻 |
|---|---|---|---|
| `id` | `Q-n` | 필수 | 질문 id |
| `text` | 문자열 | 필수 | 질문 |
| `origin` | `analysis`·`impact`·`qa`·`sasu` | 필수 | 어디서 나온 질문인가 |
| `blocking` | 참/거짓 | 필수 | 답이 없으면 진행할 수 없는가 |
| `options` | 배열 `{ key, label, consequence }` | 검사 | 선택지. `consequence` 는 "이 답이 바꾸는 구현" |
| `recommended` | 선택지 키 | 선택 | 추천 선택지 |
| `rationale` | 근거 배열 | 선택 | 추천의 근거 |
| `affects` | 요구 또는 시나리오 id 배열 | 검사 | 걸린 요구 |
| `audience` | 차이와 같음 | 선택 | 누가 답하나 |
| `answer` | — | 사람의 칸 | 쓰지 않는다 |

선택지도 `affects` 도 없는 질문은 거부된다. 선택지가 있으면 선택지마다 `consequence` 가 있어야 한다.

## assumptions[] — 가정

| 칸 | 형식 | 필수 | 뜻 |
|---|---|---|---|
| `id` | `A-n` | 필수 | 가정 id |
| `text` | 문자열 | 필수 | 가정 |
| `basis` | 문자열 | 필수 | 근거, 또는 근거가 없는 이유 |
| `requirement_ids` | 요구 id 배열 | 선택 | 걸린 요구 |
| `status` | — | 사람의 칸 | 쓰지 않는다 |

## coverage[] — 범위 장부

| 칸 | 형식 | 필수 | 뜻 |
|---|---|---|---|
| `id` | `C-n` | 필수 | 행 id |
| `unit_ids` | `U-n` 배열(1개 이상) | 필수 | 이 행이 처리하는 단위 |
| `disposition` | `covered`·`out_of_scope`·`not_app`·`duplicate`·`context` | 필수 | 처리 방식 |
| `requirement_ids` | 요구 id 배열 | 검사 | `covered` 일 때 이것 또는 `screen_ids` 중 하나는 필요 |
| `screen_ids` | 화면 id 배열 | 검사 | Figma 화면 단위는 화면으로, 문서 단위는 요구로 덮는다 |
| `quote` | 문자열 | 검사 | `out_of_scope` 일 때 필수. 행의 단위 본문에 있는 원문 인용 |
| `reason` | 문자열 | 검사 | `out_of_scope`·`not_app` 일 때 필수 |
| `delta_id` | `D-n` | 선택 | `drop` 결정으로 범위 밖이 된 경우 |

규칙

- 모든 원문 단위(`sources/units.json`)가 정확히 한 행에 들어 있어야 한다. 빠져도, 두 행에 들어가도 거부된다.
- 한 행이 같은 처리의 단위 여러 개를 묶을 수 있다.
- 웹·모웹 레인의 Figma 단위(`platform` 이 `web` 또는 `mobile_web`)는 코어가 `not_app` 으로 자동 처리하므로 행을 쓰지 않아도 된다. 써도 된다.
- `context` 로 넘기기 전에 그 단위 안에 앱이 해야 할 일이 숨어 있지 않은지 본다.

## impact — 영향 분석

| 칸 | 형식 | 필수 | 뜻 |
|---|---|---|---|
| `areas` | 배열 `{ id, screen_ids, paths, components, feature_flag? }` | 선택 | 바뀔 영역. `id` 는 `I-n` |
| `apis` | 배열 `{ method, path, fields, presence }` | 선택 | 바뀌는 API. `presence` 는 `{ "환경 이름": true/false }`. 비어 있으면 거부된다 |
| `assets` | 배열 `{ name, exists, path? }` | 선택 | 시안의 아이콘·그래픽이 저장소에 있는지 |
| `blockers` | 배열 `{ id, kind, detail, question_id? }` | 선택 | 막힐 것. `id` 는 `B-n`, `kind` 는 `missing_asset`·`missing_api`·`missing_field`·`unclear_component`·`other`. `question_id` 가 없으면 거부된다 |
| `environment` | 객체 `{ name?, basis? }` | 선택 | 고른 서버 환경과 근거 |

`impact` 는 비어 있어도 객체(`{}`)로는 있어야 한다.

## 자주 거부되는 이유와 고치는 법

| 코드 | 뜻 | 고치는 법 |
|---|---|---|
| `quote_not_found` | 인용이 그 단위 본문에 없거나, 이미지 근거를 확인할 수 없다 | `units.json` 에서 그 단위의 `text` 를 다시 열어 글자 그대로 옮긴다. 단위 id 를 바꿔 끼워 맞추지 않는다. 원문에 근거가 없으면 변경 항목이 아니라 질문이나 가정으로 올린다 |
| `coverage_incomplete` | 어느 행에도 없는 단위, 또는 두 행 이상에 든 단위가 있다 | 오류가 알려 준 `U-n` 을 장부 행에 넣거나, 중복된 행에서 빼 정확히 한 행에만 둔다. 웹·모웹 Figma 단위는 생략해도 된다 |
| `confirmed_with_open` | `confirmed` 요구가 열린 질문·차이·가정에 걸려 있다 | 걸린 항목이 열려 있는 한 `pending` 이다. 처음 제출에서는 모든 질문·차이·가정이 열려 있으므로, 이들에 걸린 요구는 `pending` 으로 쓴다 |
| `blocker_without_question` | 막힘이 질문으로 이어지지 않았다 | 그 막힘을 묻는 질문(`origin` 은 `impact`)을 만들고 막힘의 `question_id` 에 그 `Q-n` 을 적는다 |
| `evidence_operator_row` | 주체가 운영자인 단위를 근거로 썼다 | 앱 사용자가 주체인 행, 시안, 작업 구분 표의 Mobile(App) 칸에서 근거를 다시 찾는다. 운영자 행은 장부에서 `not_app` 으로 처리한다 |

그 밖에 자주 나오는 것: `schema_invalid`(칸 형식이나 열거값이 틀림), `id_format`(id 형식), `ref_missing`(없는 화면·요구·단위를 가리킴), `change_without_evidence`(근거 없는 변경 항목), `ac_missing`·`ac_without_verify`(인수 조건 또는 검증 수단 없음), `scope_out_without_quote`(범위 밖 처리에 인용이나 사유 없음), `question_without_options`(선택지·영향이 없는 질문), `delta_decision_kind`(차이 종류에 맞지 않는 추천 결정), `delta_same_decision`(경고: 앞의 차이와 종류가 같고 비교 값 쌍이 같거나 한쪽이 다른 쪽에 포함되며 추천 결정이 서로 다르지 않다. 사람이 내릴 결정이 같으면 차이 하나로 묶고 걸린 요구를 모두 적는다. 결정이 요구마다 갈릴 수 있으면 나눈 채 둔다. 게이트에서는 비슷한 차이에 같은 결정을 한 번에 적용할 수 있다).
