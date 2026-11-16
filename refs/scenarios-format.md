# QA 시나리오(`scenarios`) 형식 안내

`hew submit scenarios` 로 내는 JSON 파일의 형식이다. 최상위는 `items` 가 아니라 아래 세 묶음을 바로 가진 객체다(공통 틀은 코어가 씌운다). 정확한 예시는 이 폴더의 파일이다.

- 통과하는 시나리오 문서 예시: `refs/scenarios.example.json`
- 그 예시가 가리키는 분석 문서: `refs/analysis.example.json` (요구, 인수 조건, 화면, 영향 분석의 API 를 거기서 읽는다)

예시는 실제 일감의 내용이 아니라 형식을 보이는 합성 자료다. 칸의 모양과 id 쓰는 법만 따르고 내용은 베끼지 않는다. 시나리오는 정본 분석 문서(`doc/analysis.json`)가 있어야 검사받는다.

## 쓰는 규칙

- 아래 표에 없는 칸을 만들지 않는다. 스키마에 없는 키는 코어가 버리고 경고(`unknown_field_dropped`)를 낸다.
- 표의 "필수" 는 스키마가 요구하는 칸이다. "검사" 는 칸 자체는 비워도 되지만 결정적 검사가 채우라고 요구하는 경우다. "선택" 은 비워도 된다. 목록 칸은 비우면 `[]` 다.
- id 형식: 시나리오 `시나리오-n`, 기대 결과 `시나리오-n/E-k`(앞부분이 소속 시나리오 id 와 같아야 한다), 질문 `Q-n`. n 은 1 부터 시작하는 숫자다. 요구·인수 조건·화면은 분석 문서의 id(`요구-n`, `요구-n/AC-k`, `화면-n`, `화면-n.m`)를 그대로 쓴다.
- 같은 종류의 id 를 두 번 쓰지 않는다. 질문 id 는 분석 문서의 질문 id 와도 겹치면 안 된다. 재제출에서는 같은 항목이 같은 id 를 유지한다.
- 단계는 사람의 말로 쓴다. 셀렉터나 좌표는 쓰지 않는다. 기대 결과는 화면에서 눈으로 확인할 수 있는 것만 쓰고, 문구는 요구에 적힌 그대로 옮긴다.

## 사람이 채우는 칸은 비워 둔다

| 묶음 | 칸 | 채우는 사람의 입력 |
|---|---|---|
| `questions[]` | `answer` | 선택지 키 또는 자유 답. 제출한 값은 코어가 버리고 경고(`human_field_ignored`)를 낸다 |

실서버와 모킹(`backend`)은 사람이 게이트에서 바꿀 수 있다. 바꾼 값은 `doc/answers.json` 의 `scenarios` 에 따로 저장되고, 코어는 검사할 때 그 값을 실제 `backend` 로 본다. 이 문서의 `backend` 를 직접 고쳐 사람의 선택을 되돌리지 않는다. 답을 반영하는 재제출에서는 바뀐 값에 맞게 `mock` 또는 `environment` 칸을 채운다.

## 최상위

| 묶음 | 형식 | 필수 | 뜻 |
|---|---|---|---|
| `scenarios` | 객체 배열 | 필수 | 시나리오 |
| `preflight` | 객체 배열 | 선택 | 실행하는 날 확인할 환경 상태(실행 전 확인). 게이트의 열린 항목이 아니다 |
| `accounts` | 객체 배열 | 선택 | 시나리오가 요구하는 계정 상태와 지금 가진 계정으로 되는지. 게이트의 열린 항목이 아니다 |
| `questions` | 객체 배열 | 선택 | QA 설계가 올리는 질문 |

## scenarios[] — 시나리오

| 칸 | 형식 | 필수 | 뜻 |
|---|---|---|---|
| `id` | `시나리오-n` | 필수 | 시나리오 id |
| `title` | 문자열 | 필수 | 제목 |
| `journey` | 문자열 | 필수 | 사용자 여정 한 문장 |
| `requirement_ids` | 요구 id 배열 | 선택 | 덮는 요구 |
| `ac_ids` | 인수 조건 id 배열 | 선택 | 덮는 인수 조건. 그 인수 조건이 속한 요구가 `requirement_ids` 에 있어야 한다 |
| `preconditions` | 객체 | 선택 | 전제(아래 표) |
| `steps` | 배열 | 검사 | 단계. 하나 이상 필요 |
| `expected` | 배열 | 검사 | 기대 결과. 하나 이상 필요. 승인 때 잠긴다 |
| `backend` | `real`·`mock` | 필수 | 실서버로 보는가, 모킹하는가. 사람이 게이트에서 바꿀 수 있다 |
| `mock` | 객체 | 검사 | `backend` 가 `mock` 일 때 필수(아래 표) |
| `environment` | 문자열 | 검사 | `backend` 가 `real` 일 때 쓰는 서버 환경 이름. `impact.apis[].presence` 의 키와 같은 이름 |
| `reach` | `deeplink`·`navigation`·`unknown` | 선택 | 화면에 도달하는 방법. 비우면 `unknown` |
| `platforms` | `ios`·`android` 배열 | 선택 | 실행할 플랫폼. 비우면 둘 다 |

`preconditions`

| 칸 | 형식 | 필수 | 뜻 |
|---|---|---|---|
| `account_state` | 문자열 | 선택 | 필요한 계정 상태 |
| `feature_flags` | 문자열 배열 | 선택 | 켜야 하는 피처플래그 |
| `data` | 문자열 | 선택 | 필요한 데이터 |

`steps[]`

| 칸 | 형식 | 필수 | 뜻 |
|---|---|---|---|
| `n` | 1 이상의 정수 | 필수 | 순서 |
| `action` | 문자열 | 필수 | 사람의 말로 쓴 동작 |
| `screen_id` | 화면 또는 변형 id | 선택 | 이 단계가 있는 화면 |

`expected[]`

| 칸 | 형식 | 필수 | 뜻 |
|---|---|---|---|
| `id` | `시나리오-n/E-k` | 필수 | 기대 결과 id |
| `text` | 문자열 | 검사 | 화면에서 확인할 것. 비면 거부된다 |
| `screen_id` | 화면 또는 변형 id | 선택 | 확인할 화면 |

`mock`

| 칸 | 형식 | 필수 | 뜻 |
|---|---|---|---|
| `endpoints` | 배열 `{ method, path, case }` | 검사 | 흉내 낼 엔드포인트와 경우. 하나 이상 |
| `reason` | 문자열 | 검사 | 모킹하는 이유 |

## preflight[] — 실행 전 확인

실행하는 날의 환경 상태("QA 하는 날 staging 에 새 적립률이 반영돼 있는가", "이 플래그가 켜져 있는가")는 승인하는 날 답할 수 없으므로 질문으로 올리지 않는다. 여기에 적어 두면 게이트에 목록으로 보이고, 실행하는 날 QA 가 확인한다.

| 칸 | 형식 | 필수 | 뜻 |
|---|---|---|---|
| `id` | `PF-n` | 필수 | 실행 전 확인 id |
| `text` | 문자열 | 필수 | 확인할 환경 상태 |
| `kind` | `env`·`deploy`·`flag`·`data` | 필수 | 환경, 배포, 플래그, 데이터 |
| `scenario_ids` | 시나리오 id 배열 | 필수 | 이 확인이 걸린 시나리오. 하나 이상 |
| `check` | 문자열 | 필수 | 무엇을 어떻게 확인하는지. 비어 있으면 거부 |
| `fallback` | `mock`·`hold` | 필수 | 확인이 안 될 때: 모킹으로 돌린다 / 그 시나리오를 보류하고 보고한다 |

`fallback` 이 `mock` 인데 걸린 시나리오가 실서버이고 `mock` 칸(엔드포인트)이 비어 있으면 모킹으로 돌릴 준비가 안 된 것이라 `preflight_mock_unprepared` 경고가 난다.

## accounts[] — 필요한 계정

시나리오가 요구하는 계정 상태를 한 줄씩 적는다. 계정마다 질문을 만들지 않는다. 사람은 게이트에서 이 목록을 한 번에 보고, 안 되는 줄에 준비 상황을 메모로 남길 수 있다(메모는 승인·revision 과 무관하다).

| 칸 | 형식 | 필수 | 뜻 |
|---|---|---|---|
| `id` | `AC-n` | 필수 | 계정 id |
| `state` | 문자열 | 필수 | 필요한 계정 상태 |
| `available` | 참/거짓 | 필수 | 지금 가진 테스트 계정으로 되는가 |
| `scenario_ids` | 시나리오 id 배열 | 필수 | 이 계정이 필요한 시나리오. 하나 이상 |
| `note` | 문자열 | 선택 | 안 될 때 무엇이 더 필요한지 |

`available` 이 거짓인 계정이 있으면 질문 유무와 상관없이 `accounts_unavailable` 정보가 한 건 난다.

## questions[] — 질문

분석 문서의 질문과 같은 형식이다(`refs/analysis-format.md` 의 questions 표). 다른 점은 둘이다.

- `origin` 은 `qa` 여야 한다.
- `affects` 에는 요구 id 또는 이 문서의 시나리오 id 를 쓴다.
- 실행하는 날의 환경·계정 상태를 묻는 질문은 올리지 않는다(위 `preflight`, `accounts` 로 옮긴다). 사람이 승인할 때 답할 수 있는 것(예: 모킹으로만 확인해도 되는가)만 묻는다.

| 칸 | 형식 | 필수 | 뜻 |
|---|---|---|---|
| `id` | `Q-n` | 필수 | 질문 id. 분석 문서의 질문 id 와 겹치지 않는다 |
| `text` | 문자열 | 필수 | 질문 |
| `origin` | `qa` | 필수 | 항상 `qa` |
| `blocking` | 참/거짓 | 필수 | 답이 없으면 진행할 수 없는가 |
| `options` | 배열 `{ key, label, consequence }` | 검사 | 선택지. `consequence` 는 "이 답이 바꾸는 시나리오" |
| `recommended` | 선택지 키 | 선택 | 추천 선택지 |
| `rationale` | 근거 배열 | 선택 | 추천의 근거 |
| `affects` | 요구 또는 시나리오 id 배열 | 검사 | 걸린 요구·시나리오 |
| `audience` | `dev`·`po`·`designer`·`backend` 배열 | 선택 | 누가 답하나 |
| `answer` | — | 사람의 칸 | 쓰지 않는다 |

선택지도 `affects` 도 없는 질문은 거부된다. 선택지가 있으면 선택지마다 `consequence` 가 있어야 한다.

## 검사가 보는 것

거부(제출이 막힌다)

| 코드 | 뜻 |
|---|---|
| `ac_uncovered` | 검증 수단이 `qa_scenario` 인 인수 조건을 덮는 시나리오가 없다. 사람이 `drop` 으로 범위 밖으로 결정한 요구의 인수 조건은 제외 |
| `scenario_ref_missing` | 없는 요구·인수 조건·화면·시나리오(실행 전 확인·계정의 `scenario_ids`)를 가리킨다. 인수 조건의 요구가 `requirement_ids` 에 없을 때도 같은 코드 |
| `expected_empty` | 기대 결과가 없거나 `text` 가 빈 시나리오 |
| `steps_empty` | 단계가 없는 시나리오 |
| `mock_without_reason` | 모킹인데 이유나 엔드포인트가 없다 |
| `real_without_presence` | 실서버인데 `environment` 가 없거나, 영향 분석의 API 가 모두 그 환경에 없다 |
| `id_format`, `id_duplicate` | id 형식이 틀렸거나 두 번 쓰였다(시나리오, 기대 결과, 질문, `PF-n`, `AC-n`) |
| `preflight_without_check` | 실행 전 확인의 `check` 가 비어 있다 |
| `question_origin`, `question_without_options` | 질문의 `origin` 이 `qa` 가 아니다 / 선택지도 `affects` 도 없다 |
| `id_removed`, `withdraw_has_human_input` | 게이트 게시 뒤 질문이 `--withdraw` 없이 사라졌다 / 사람의 답이 있는 질문을 철회하려 했다 |
| `analysis_missing` | 정본 분석 문서가 없다 |
| `schema_invalid` | 칸 형식이나 열거값이 틀렸다 |

경고·정보(제출은 통과한다)

| 코드 | 뜻 |
|---|---|
| `mock_only_requirement` | 어떤 요구를 덮는 시나리오가 모두 모킹이다("통합 미검증") |
| `reach_unknown` | 화면에 도달하는 방법을 모른다 |
| `environment_differs` | `environment` 가 분석이 고른 환경(`impact.environment.name`)과 다르다 |
| `mock_ignored` | `backend` 가 `real` 인데 `mock` 칸이 채워져 있다. 실행 전 확인의 `fallback` 이 `mock` 인 시나리오는 예외다(모킹 정보를 채워 둬야 한다) |
| `accounts_unavailable` | 지금 가진 계정으로 안 되는 계정이 있다(정보 한 건. 질문 유무와 무관) |
| `preflight_mock_unprepared` | 안 되면 모킹으로 돌린다고 했는데 걸린 실서버 시나리오에 모킹 정보가 없다 |
| `qa_question_not_for_gate` | 질문이 실행하는 날의 환경·계정 상태를 묻는 것으로 보인다(`preflight`·`accounts` 로 옮긴다) |
| `human_field_ignored`, `unknown_field_dropped` | 사람의 칸 값 / 스키마에 없는 칸을 버렸다 |
| `item_withdrawn` | `--withdraw` 로 질문을 철회했다 |

## 자주 거부되는 이유와 고치는 법

| 코드 | 뜻 | 고치는 법 |
|---|---|---|
| `ac_uncovered` | `qa_scenario` 인 인수 조건이 어느 시나리오의 `ac_ids` 에도 없다 | 그 인수 조건이 속한 요구를 `requirement_ids` 에 넣고 `ac_ids` 에 적는 시나리오를 만들거나 기존 시나리오에 더한다. 시나리오로 못 보는 조건이면 분석 문서의 검증 수단을 고치는 일이므로 질문으로 올린다 |
| `scenario_ref_missing` | 분석 문서에 없는 id 를 썼거나, 인수 조건의 요구를 `requirement_ids` 에 빼먹었다 | `doc/analysis.json` 에서 id 를 글자 그대로 옮긴다. 화면은 변형 id(`화면-n.m`)도 쓸 수 있다 |
| `expected_empty` | 기대 결과가 없거나 비었다 | 화면에서 눈으로 확인할 수 있는 결과를 `text` 에 쓴다. "정상 동작한다" 는 기대 결과가 아니다 |
| `mock_without_reason` | 모킹인데 `mock.reason` 이나 `mock.endpoints` 가 비었다 | 어떤 엔드포인트를 어떤 경우로 흉내 내는지(`endpoints[].case`)와 이유를 적는다 |
| `real_without_presence` | 실서버인데 환경이 없거나, API 가 그 환경에 없다 | `environment` 에 영향 분석의 `presence` 에서 `true` 인 환경 이름을 적는다. 어느 환경에도 API 가 없으면 `backend` 를 `mock` 으로 하고 이유를 적는다 |
| `id_format` | 기대 결과 id 의 앞부분이 소속 시나리오와 다르거나 형식이 다르다 | `시나리오-2` 의 기대 결과는 `시나리오-2/E-1`, `시나리오-2/E-2` 로 쓴다 |
| `id_duplicate` | 같은 id 를 두 번 썼거나 질문 id 가 분석 문서와 겹친다 | 분석 문서의 질문 id 를 확인하고 겹치지 않는 번호를 쓴다 |
