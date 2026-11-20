import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import * as vscode from "vscode";
import type { Problem, SelectedProblem } from "../../types";

/** 真正的 Extension Host 入口；仅自动输入选择与本地 HTTP 服务使用测试替身。 */
export async function run(): Promise<void> {
  const cases: string[] = [],
    requests: string[] = [],
    output: string[] = [];
  const notices: string[] = [],
    errors: string[] = [];
  let chosenDomain = "school-a",
    version = "v1",
    revoked = false;
  const submitted: Array<{ domain: string; body: Record<string, unknown> }> =
    [];
  const domains = ["school-a", "school-b"].map((slug) => ({
    id: slug,
    slug,
    name: slug,
    status: "active",
  }));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    const send = (value: unknown, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/api/v1/auth/me")
      return send({ data: { id: "host-student", username: "host-student" } });
    if (url.pathname === "/api/v1/me/domains") return send({ data: domains });
    if (url.pathname === "/api/v1/auth/logout") return send({ data: {} });
    const match = url.pathname.match(
      /^\/api\/v1\/domains\/(school-[ab])\/(.*)$/,
    );
    if (!match) return send({ error: "未声明的测试接口" }, 404);
    const domain = match[1],
      resource = decodeURIComponent(match[2]);
    if (resource === "problems")
      return send({
        items: [
          {
            reference: { display_ref: "main:1001" },
            title: "共享代码题",
            kind: "ai",
          },
        ],
        total: 1,
      });
    if (resource === "submissions" && request.method === "POST") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw) as Record<string, unknown>;
      if (body.version_id !== version)
        return send(
          {
            error: {
              code: "PROBLEM_ANSWER_VERSION_CHANGED",
              message: "作答版本已变化",
            },
          },
          409,
        );
      submitted.push({ domain, body });
      return send({ data: { id: "host-submission", status: "pending" } }, 201);
    }
    if (resource === "submissions/host-submission")
      return send({
        data: {
          id: "host-submission",
          problem_id: "source-problem",
          file_name: "submission.py",
          result_visibility: "hidden",
          result: {
            score: 9876,
            time_ms: 999,
            memory_kb: 888,
            output: "FORBIDDEN_EVALUATOR_TEXT",
          },
        },
      });
    if (revoked && resource.startsWith("problems/main:1001"))
      return send({ error: { message: "资源不可访问" } }, 404);
    if (resource === "problems/main:1001/template")
      return send({
        data: {
          version_id: version,
          template_content: `# ${domain} ${version}\nprint(1)\n`,
        },
      });
    if (resource === "problems/main:1001/versions")
      return send({
        items: [
          {
            version_id: version,
            version: version === "v1" ? 1 : 2,
            change_note: "发布",
            published_at: new Date().toISOString(),
          },
        ],
        total: 1,
        page: 1,
        limit: 20,
        answer_version_id: version,
      });
    if (resource === "problems/main:1001")
      return send({
        version_id: version,
        version: version === "v1" ? 1 : 2,
        supported_languages: ["python3"],
        content: { title: "共享代码题", submission_mode: "code" },
      });
    send({ error: "未声明的测试资源" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const config = vscode.workspace.getConfiguration("neuroOj");
  await config.update(
    "serverUrl",
    `http://127.0.0.1:${address.port}`,
    vscode.ConfigurationTarget.Global,
  );
  await config.update(
    "pollIntervalSeconds",
    1,
    vscode.ConfigurationTarget.Global,
  );
  const originals = {
    input: vscode.window.showInputBox,
    pick: vscode.window.showQuickPick,
    information: vscode.window.showInformationMessage,
    warning: vscode.window.showWarningMessage,
    error: vscode.window.showErrorMessage,
    channel: vscode.window.createOutputChannel,
  };
  try {
    // 只替代交互回答，真实命令、编辑器事件、进度、存储和输出通道仍由宿主执行。
    vscode.window.showInputBox = (async () =>
      "host-fixture-token") as typeof vscode.window.showInputBox;
    Object.assign(vscode.window, {
      showQuickPick: async (items: readonly vscode.QuickPickItem[]) =>
        items.find((item) => item.description === chosenDomain),
    });
    vscode.window.showInformationMessage = (async (
      message: string,
      ...items: unknown[]
    ) => {
      notices.push(message);
      return items.includes("提交评测") ? "提交评测" : undefined;
    }) as typeof vscode.window.showInformationMessage;
    vscode.window.showWarningMessage = (async (message: string) => {
      notices.push(message);
    }) as typeof vscode.window.showWarningMessage;
    vscode.window.showErrorMessage = (async (message: string) => {
      errors.push(message);
    }) as typeof vscode.window.showErrorMessage;
    vscode.window.createOutputChannel = ((
      ...args: Parameters<typeof vscode.window.createOutputChannel>
    ) => {
      const channel = originals.channel(...args);
      return new Proxy(channel, {
        get(target, key) {
          if (key === "appendLine")
            return (line: string) => {
              output.push(line);
              target.appendLine(line);
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof vscode.window.createOutputChannel;
    const extension = vscode.extensions.getExtension("neuro-oj.neuro-oj-lmcc");
    assert(extension, "宿主必须加载当前开发扩展");
    await extension.activate();
    assert.equal(extension.isActive, true);
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      "useToken",
      "selectDomain",
      "selectProblem",
      "openTemplate",
      "showVersions",
      "submit",
      "logout",
    ])
      assert(commands.includes(`neuroOj.${command}`));
    cases.push("实际激活扩展并检查宿主注册命令");
    await vscode.commands.executeCommand("neuroOj.useToken");
    assert(notices.some((line) => line.includes("访问令牌有效")));
    cases.push("真实 SecretStorage 登录及域题库加载");
    const problem: Problem = {
      id: "main:1001",
      display_id: "main:1001",
      title: "共享代码题",
      difficulty: "",
      is_objective: false,
      submission_mode: "code",
    };
    const choose = () =>
      vscode.commands.executeCommand<SelectedProblem>(
        "neuroOj.selectProblem",
        problem,
      );
    const a = await choose();
    assert.equal(a.domainSlug, "school-a");
    assert.equal(a.displayId, "main:1001");
    await vscode.commands.executeCommand("neuroOj.openTemplate");
    const draft = vscode.window.activeTextEditor!;
    assert.equal(draft.document.languageId, "python");
    await draft.edit((edit) =>
      edit.insert(new vscode.Position(0, 0), "# STUDENT_DRAFT_A\n"),
    );
    // 等实际 onDidChangeTextDocument 与异步 Memento 写入完成。
    await new Promise((resolve) => setTimeout(resolve, 100));
    chosenDomain = "school-b";
    await vscode.commands.executeCommand("neuroOj.selectDomain");
    assert.equal((await choose()).domainSlug, "school-b");
    await vscode.commands.executeCommand("neuroOj.openTemplate");
    assert(
      !vscode.window
        .activeTextEditor!.document.getText()
        .includes("STUDENT_DRAFT_A"),
    );
    chosenDomain = "school-a";
    await vscode.commands.executeCommand("neuroOj.selectDomain");
    await choose();
    await vscode.commands.executeCommand("neuroOj.openTemplate");
    assert(
      vscode.window
        .activeTextEditor!.document.getText()
        .includes("STUDENT_DRAFT_A"),
    );
    cases.push("真实编辑器事件保存草稿，两个域的同源题互不覆盖");
    version = "v2";
    await choose();
    await vscode.commands.executeCommand("neuroOj.openTemplate");
    assert(
      !vscode.window
        .activeTextEditor!.document.getText()
        .includes("STUDENT_DRAFT_A"),
    );
    await vscode.commands.executeCommand("neuroOj.showVersions");
    cases.push("新版本草稿独立，并通过已注册命令读取版本沿革");
    const folder = vscode.workspace.workspaceFolders![0].uri;
    const file = vscode.Uri.joinPath(folder, "submission.py");
    await vscode.workspace.fs.writeFile(
      file,
      Buffer.from("print('host code')\n"),
    );
    const code = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(code);
    await vscode.commands.executeCommand("neuroOj.submit");
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].domain, "school-a");
    assert.equal(submitted[0].body.problem_ref, "main:1001");
    assert.equal(submitted[0].body.version_id, "v2");
    assert.equal(submitted[0].body.code, code.getText());
    assert(output.some((line) => line.includes("结果按比赛规则暂未公开")));
    assert(
      !output.some((line) =>
        /98\.76|999 ms|888 KiB|FORBIDDEN_EVALUATOR_TEXT/.test(line),
      ),
    );
    assert(!notices.some((line) => line.includes("98.76")));
    cases.push("真实提交命令携带使用域与版本，隐藏反馈不进入宿主输出");
    version = "v3";
    await vscode.commands.executeCommand("neuroOj.submit");
    assert.equal(submitted.length, 1);
    assert.equal(code.getText(), "print('host code')\n");
    assert(notices.some((line) => line.includes("当前文件保留")));
    cases.push("版本冲突保留实际文件，拒绝静默更新版本提交");
    revoked = true;
    assert.equal(await choose(), undefined);
    assert.equal(code.getText(), "print('host code')\n");
    assert(errors.some((line) => line.includes("资源不可访问")));
    assert(!notices.some((line) => line.includes("尚未发布任何版本")));
    assert(!requests.some((item) => item.includes("/api/v1/problems")));
    cases.push("共享撤销后真实题目选择拒绝，保持本地代码且不回退旧入口");
    await vscode.commands.executeCommand("neuroOj.logout");
    assert(notices.includes("已退出 Neuro OJ"));
    await vscode.commands.executeCommand("neuroOj.submit");
    assert(notices.includes("请先登录 Neuro OJ"));
    assert.equal(submitted.length, 1);
    cases.push("已注册退出命令清除真实宿主会话");
    writeReport("passed");
  } catch (error) {
    writeReport(
      "failed",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  } finally {
    vscode.window.showInputBox = originals.input;
    vscode.window.showQuickPick = originals.pick;
    vscode.window.showInformationMessage = originals.information;
    vscode.window.showWarningMessage = originals.warning;
    vscode.window.showErrorMessage = originals.error;
    vscode.window.createOutputChannel = originals.channel;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  function writeReport(status: string, failure?: string) {
    const target = process.env.NOJ_EXTENSION_HOST_REPORT;
    assert(target, "使用 npm run test:host 提供独立报告目录");
    writeFileSync(
      target,
      JSON.stringify(
        {
          status,
          vscode_version: vscode.version,
          boundary:
            "真实 Extension Host + 自动交互回答 + 本地模拟 HTTP；不代表真实 core/Judge 全链路",
          cases,
          requests,
          ...(failure ? { failure } : {}),
        },
        null,
        2,
      ),
    );
  }
}
