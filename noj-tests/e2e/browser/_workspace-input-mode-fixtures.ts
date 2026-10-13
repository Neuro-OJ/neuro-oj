import { assertEquals } from "jsr:@std/assert@^1.0.13";
import { strToU8, zipSync } from "npm:fflate@0.8.2";
import { api, BASE_URL, registerUser, TEST_PASSWORD } from "../helper.ts";

export interface InputModeAccount {
  id: string;
  email: string;
  token: string;
}
export interface InputModeProblem {
  id: string;
  number: number;
  reference: string;
  v1: string;
  v2: string;
}
export async function inputModeFixture<T>(
  method: string,
  path: string,
  token: string,
  body?: unknown,
  revision?: number,
): Promise<T> {
  const result = await api(method, `/api/v1${path}`, {
    token,
    body,
    ...(revision === undefined
      ? {}
      : { headers: { "If-Match": String(revision) } }),
  });
  assertEquals(
    result.status >= 200 && result.status < 300,
    true,
    `${method} ${path}: ${result.status} ${JSON.stringify(result.body)}`,
  );
  return result.body as T;
}
export async function inputModeAccount(
  suffix: string,
): Promise<InputModeAccount> {
  const username = `input_student_${suffix}`, email = `${username}@test.com`;
  const token = await registerUser(username, email, TEST_PASSWORD);
  const { data } = await inputModeFixture<
    { data: { id: string; is_admin: boolean } }
  >("GET", "/auth/me", token);
  assertEquals(data.is_admin, false);
  return { id: data.id, email, token };
}
export async function joinInputModeDomain(
  slug: string,
  admin: string,
  student: InputModeAccount,
) {
  const invitation = await inputModeFixture<{ data: { token: string } }>(
    "POST",
    `/domains/${slug}/invitations`,
    admin,
    { email: student.email },
  );
  await inputModeFixture("POST", "/domain-invitations/accept", student.token, {
    token: invitation.data.token,
  });
}
const predictionEvaluator = `import os, json
path = os.path.join(os.environ["NOJ_PREDICTION_DIR"], os.environ["NOJ_PREDICTION_FILE"])
predictions = dict(line.strip().split(",") for line in open(path) if line.strip())
labels = json.load(open("/workspace/hidden-labels.json"))
correct = sum(predictions.get(key) == value for key,value in labels.items())
print("---RESULT---")
print(json.dumps({"score": int(10000*correct/len(labels)), "details": {"cases": [{"case_id":key,"hidden":True,"status":"Accepted" if predictions.get(key)==value else "WrongAnswer"} for key,value in labels.items()]}}))
`;
function uiHtml(version: number) {
  return `<h2>界面版本 V${version}</h2><label>参数提示<input id="prompt" aria-label="参数提示"></label>
<button id="run">界面自测</button><button id="go">界面提交</button><p id="score" role="status">尚未运行</p>
<script>
const input=document.getElementById('prompt'), output=document.getElementById('score');
function render(values){input.value=values.prompt||'';}
NOJ.onInit(render);NOJ.onSet(render);
input.oninput=()=>NOJ.setValues({prompt:input.value});
document.getElementById('run').onclick=NOJ.selfTest;document.getElementById('go').onclick=NOJ.submit;
NOJ.onDisabled(value=>{input.disabled=value;document.getElementById('go').disabled=value;document.getElementById('run').disabled=value;});
NOJ.onResult(value=>{output.textContent=value?value.label+(value.score==null?'':' '+value.score+' 分'):'尚未运行';});
</script>`;
}
function bundle(
  mode: "prediction" | "ui",
  version: number,
  title: string,
  number?: number,
) {
  const tag = Deno.env.get("E2E_INPUT_MODES_IMAGE_TAG") || "latest";
  const runtime = {
    evaluator: {
      image: `noj-evaluator-python:${tag}`,
      command: "python3 /workspace/evaluate.py",
      time_limit_ms: 20000,
      memory_limit_mb: 256,
      ...(mode === "prediction" ? { workspace_size_mb: 512 } : {}),
    },
    ...(mode === "ui"
      ? {
        solution: {
          image: `noj-solution-python:${tag}`,
          call_timeout_ms: 5000,
          memory_limit_mb: 256,
        },
      }
      : {}),
  };
  const files: Record<string, Uint8Array> = {
    "problem.json": strToU8(
      JSON.stringify({
        format_version: 2,
        title,
        description: "真实输入模式浏览器评测夹具",
        number,
        submission_mode: mode,
        runtime_config: runtime,
      }),
    ),
  };
  if (mode === "prediction") {
    files["evaluate.py"] = strToU8(predictionEvaluator);
    files["hidden-labels.json"] = strToU8(
      JSON.stringify({ c1: "1", c2: version === 1 ? "1" : "0" }),
    );
  } else {
    files["ui.html"] = strToU8(uiHtml(version));
    files["template.py"] = strToU8(
      "from noj_solution_sdk import register\n@register\ndef solve(): return prompt\n",
    );
    files["evaluate.py"] = strToU8(
      `from noj_evaluator_sdk import SolutionRunner, result
runner=SolutionRunner()
try:
    value=runner.call("solve")
    if value==${JSON.stringify(version === 1 ? "first" : "second")}:
        result.accept(score=100)
    else:
        result.wrong_answer(score=40)
finally:
    runner.close()
`,
    );
  }
  return zipSync(files);
}
async function importVersion(
  slug: string,
  mode: "prediction" | "ui",
  version: number,
  token: string,
  number?: number,
) {
  const body = new FormData(),
    bytes = bundle(mode, version, `${mode} 浏览器 V${version}`, number);
  body.set(
    "file",
    new Blob([bytes.buffer as ArrayBuffer], { type: "application/zip" }),
    `${mode}.zip`,
  );
  const existing = number === undefined
    ? null
    : await inputModeFixture<{ revision: number }>(
      "GET",
      `/domains/${slug}/problems/${number}/draft`,
      token,
    );
  const response = await fetch(
    `${BASE_URL}/api/v1/domains/${slug}/problems/import-bundle`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(existing ? { "If-Match": String(existing.revision) } : {}),
      },
      body,
    },
  );
  const parsed = await response.json();
  assertEquals(
    response.status,
    number === undefined ? 201 : 200,
    JSON.stringify(parsed),
  );
  const draft = parsed.data as {
    problem_id: string;
    number: number;
    draft_revision: number;
  };
  const published = await inputModeFixture<{ version_id: string }>(
    "POST",
    `/domains/${slug}/problems/${draft.number}/publish`,
    token,
    { change_note: `输入模式V${version}` },
    draft.draft_revision,
  );
  return { ...draft, version_id: published.version_id };
}
export async function inputModeProblem(
  slug: string,
  mode: "prediction" | "ui",
  admin: string,
): Promise<InputModeProblem> {
  const first = await importVersion(slug, mode, 1, admin);
  return {
    id: first.problem_id,
    number: first.number,
    reference: `${slug}:${first.number}`,
    v1: first.version_id,
    v2: "",
  };
}
export async function inputModeVersionTwo(
  slug: string,
  mode: "prediction" | "ui",
  problem: InputModeProblem,
  admin: string,
) {
  const second = await importVersion(slug, mode, 2, admin, problem.number);
  problem.v2 = second.version_id;
}
export async function shareInputModeProblem(
  source: string,
  problem: InputModeProblem,
  schools: string[],
  admin: string,
) {
  const { data } = await inputModeFixture<{ data: { revision: number } }>(
    "GET",
    `/domains/${source}/problems/${problem.number}/sharing`,
    admin,
  );
  await inputModeFixture(
    "POST",
    `/domains/${source}/problems/${problem.number}/sharing`,
    admin,
    { enabled: true, scope: "selected", target_domain_slugs: schools },
    data.revision,
  );
  for (const slug of schools) {
    await inputModeFixture("POST", `/domains/${slug}/problem-bindings`, admin, {
      source_ref: problem.reference,
    });
  }
}
export async function inputModePolicy(
  slug: string,
  problem: InputModeProblem,
  admin: string,
  version: string | null,
) {
  const resource = await inputModeFixture<{ policy_revision: number }>(
    "GET",
    `/domains/${slug}/problems/${problem.reference}`,
    admin,
  );
  await inputModeFixture(
    "PUT",
    `/domains/${slug}/problems/${problem.reference}/policy`,
    admin,
    {
      policy: version
        ? { mode: "exact", version_id: version }
        : { mode: "any" },
      reason: "真实浏览器使用域版本夹具",
    },
    resource.policy_revision,
  );
}
