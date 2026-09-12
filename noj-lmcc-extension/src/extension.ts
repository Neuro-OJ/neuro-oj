import * as path from "node:path";
import * as vscode from "vscode";
import { ApiError, NeuroOjApi, normalizeServerUrl } from "./api";
import { pollSubmission } from "./polling";
import { ProblemsTreeProvider } from "./problemsTree";
import type { Problem, SelectedProblem, SubmissionDetail, User } from "./types";

const USER_KEY = "neuroOj.user";
const SELECTED_PROBLEM_KEY = "neuroOj.selectedProblem";

let api: NeuroOjApi;
let tree: ProblemsTreeProvider;
let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;
let currentServerUrl = "";

/** 激活 Neuro OJ 扩展。 */
export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  output = vscode.window.createOutputChannel("Neuro OJ");
  tree = new ProblemsTreeProvider();
  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  statusBar.command = "neuroOj.submit";
  statusBar.tooltip = "提交当前 Python 文件到 Neuro OJ";
  statusBar.show();

  context.subscriptions.push(
    output,
    statusBar,
    vscode.window.registerTreeDataProvider("neuroOj.problems", tree),
    vscode.commands.registerCommand("neuroOj.configureServer", () =>
      configureServer(context),
    ),
    vscode.commands.registerCommand("neuroOj.login", () => login(context)),
    vscode.commands.registerCommand("neuroOj.useToken", () =>
      useToken(context),
    ),
    vscode.commands.registerCommand("neuroOj.logout", () => logout(context)),
    vscode.commands.registerCommand("neuroOj.refreshProblems", () =>
      refreshProblems(context),
    ),
    vscode.commands.registerCommand(
      "neuroOj.selectProblem",
      (problem?: Problem) => selectProblem(context, problem),
    ),
    vscode.commands.registerCommand("neuroOj.submit", () => submit(context)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("neuroOj")) void initializeApi(context);
    }),
  );

  await initializeApi(context);
}

async function initializeApi(context: vscode.ExtensionContext): Promise<void> {
  try {
    const config = vscode.workspace.getConfiguration("neuroOj");
    const serverUrl = normalizeServerUrl(
      config.get<string>("serverUrl", "http://localhost:3000"),
    );
    currentServerUrl = serverUrl;
    const timeoutMs = config.get<number>("requestTimeoutSeconds", 15) * 1000;
    api = new NeuroOjApi(serverUrl, timeoutMs);
    const token = await context.secrets.get(tokenKey(serverUrl));
    api.setToken(token);
    const authenticated = Boolean(token);
    await setAuthenticated(authenticated);
    updateStatusBar(context);
    if (authenticated) {
      await refreshProblems(context, false);
    } else {
      tree.setMessage("请先登录 Neuro OJ");
    }
  } catch (error) {
    tree.setMessage(`服务器配置错误：${messageOf(error)}`);
    statusBar.text = "$(warning) Neuro OJ 配置错误";
    statusBar.command = "neuroOj.configureServer";
  }
}

async function configureServer(
  context: vscode.ExtensionContext,
): Promise<void> {
  const config = vscode.workspace.getConfiguration("neuroOj");
  const current = config.get<string>("serverUrl", "http://localhost:3000");
  const input = await vscode.window.showInputBox({
    title: "配置 Neuro OJ 服务器",
    prompt: "请输入网站地址，例如 https://noj.example.com",
    value: current,
    ignoreFocusOut: true,
  });
  if (input === undefined) return;

  try {
    const serverUrl = normalizeServerUrl(input);
    const timeoutMs = config.get<number>("requestTimeoutSeconds", 15) * 1000;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "正在连接 Neuro OJ…",
        },
        async () => {
          const probe = new NeuroOjApi(serverUrl, timeoutMs);
          await probe.checkConnection();
        },
      );
    } catch (error) {
      const action = await vscode.window.showWarningMessage(
        `暂时无法连接 ${serverUrl}：${messageOf(error)}`,
        "仍然保存",
        "取消",
      );
      if (action !== "仍然保存") return;
    }
    await config.update(
      "serverUrl",
      serverUrl,
      vscode.ConfigurationTarget.Global,
    );
    await initializeApi(context);
    vscode.window.showInformationMessage(
      `Neuro OJ 服务器已设置为 ${serverUrl}`,
    );
  } catch (error) {
    showError("服务器地址不可用", error);
  }
}

async function login(context: vscode.ExtensionContext): Promise<void> {
  const loginName = await vscode.window.showInputBox({
    title: "登录 Neuro OJ",
    prompt: "用户名或邮箱",
    ignoreFocusOut: true,
  });
  if (!loginName) return;
  const password = await vscode.window.showInputBox({
    title: "登录 Neuro OJ",
    prompt: "密码",
    password: true,
    ignoreFocusOut: true,
  });
  if (!password) return;

  try {
    let result: { user: User; token: string };
    try {
      result = await api.login(loginName, password);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "TFA_REQUIRED")
        throw error;
      const code = await vscode.window.showInputBox({
        title: "两步验证",
        prompt: "请输入 6 位验证码或恢复码",
        password: true,
        ignoreFocusOut: true,
      });
      if (!code) return;
      result = await api.login(loginName, password, code);
    }
    if (result.user.must_change_password) {
      throw new Error("账号需要先在 Neuro OJ 网站修改初始密码");
    }
    await saveSession(context, result.token, result.user);
    vscode.window.showInformationMessage(
      `已登录 Neuro OJ：${result.user.username}`,
    );
    await refreshProblems(context);
  } catch (error) {
    showError("登录失败", error);
  }
}

async function useToken(context: vscode.ExtensionContext): Promise<void> {
  const token = await vscode.window.showInputBox({
    title: "使用 Neuro OJ 访问令牌",
    prompt: "令牌只会保存在系统加密凭据存储中",
    password: true,
    ignoreFocusOut: true,
  });
  if (!token) return;

  try {
    api.setToken(token);
    const user = await api.currentUser();
    if (user.must_change_password) {
      throw new Error("账号需要先在 Neuro OJ 网站修改初始密码");
    }
    await saveSession(context, token, user);
    vscode.window.showInformationMessage(
      `访问令牌有效，已登录：${user.username}`,
    );
    await refreshProblems(context);
  } catch (error) {
    api.setToken(undefined);
    showError("令牌验证失败", error);
  }
}

async function saveSession(
  context: vscode.ExtensionContext,
  token: string,
  user: User,
): Promise<void> {
  await context.secrets.store(tokenKey(currentServerUrl), token);
  await context.globalState.update(USER_KEY, user);
  api.setToken(token);
  await setAuthenticated(true);
  updateStatusBar(context);
}

async function logout(context: vscode.ExtensionContext): Promise<void> {
  try {
    await api.logout();
  } catch (error) {
    output.appendLine(`[退出登录] 服务端会话注销失败：${messageOf(error)}`);
  } finally {
    await clearSession(context);
    vscode.window.showInformationMessage("已退出 Neuro OJ");
  }
}

async function clearSession(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(tokenKey(currentServerUrl));
  await context.globalState.update(USER_KEY, undefined);
  api.setToken(undefined);
  tree.setMessage("请先登录 Neuro OJ");
  await setAuthenticated(false);
  updateStatusBar(context);
}

async function refreshProblems(
  context: vscode.ExtensionContext,
  notify = true,
): Promise<Problem[]> {
  tree.setLoading();
  try {
    const problems = await api.listProblems();
    const selected =
      context.globalState.get<SelectedProblem>(SELECTED_PROBLEM_KEY);
    tree.setProblems(problems, selected);
    if (notify)
      vscode.window.setStatusBarMessage(
        `Neuro OJ：已加载 ${problems.length} 道代码题`,
        2500,
      );
    return problems;
  } catch (error) {
    await handleAuthenticatedError(context, error);
    tree.setMessage(`加载失败：${messageOf(error)}`);
    if (notify) showError("加载题目失败", error);
    return [];
  }
}

async function selectProblem(
  context: vscode.ExtensionContext,
  problem?: Problem,
): Promise<SelectedProblem | undefined> {
  let chosen = problem;
  if (!chosen) {
    const problems = await refreshProblems(context, false);
    const picked = await vscode.window.showQuickPick(
      problems.map((item) => ({
        label: `${item.display_id} · ${item.title}`,
        description: item.difficulty,
        problem: item,
      })),
      { title: "选择要提交的 Neuro OJ 题目", matchOnDescription: true },
    );
    chosen = picked?.problem;
  }
  if (!chosen) return undefined;

  const selected: SelectedProblem = {
    id: chosen.id,
    displayId: chosen.display_id,
    title: chosen.title,
  };
  await context.globalState.update(SELECTED_PROBLEM_KEY, selected);
  tree.markSelected(selected);
  updateStatusBar(context);
  vscode.window.setStatusBarMessage(
    `当前题目：${selected.displayId} ${selected.title}`,
    3000,
  );
  return selected;
}

async function submit(context: vscode.ExtensionContext): Promise<void> {
  const token = await context.secrets.get(tokenKey(currentServerUrl));
  if (!token) {
    const action = await vscode.window.showWarningMessage(
      "请先登录 Neuro OJ",
      "登录",
      "使用令牌",
    );
    if (action === "登录") await login(context);
    if (action === "使用令牌") await useToken(context);
    if (!(await context.secrets.get(tokenKey(currentServerUrl)))) return;
  }

  let selected = context.globalState.get<SelectedProblem>(SELECTED_PROBLEM_KEY);
  if (!selected) selected = await selectProblem(context);
  if (!selected) return;

  const document = await resolvePythonDocument();
  if (!document) return;
  const code = document.getText();
  if (!code.trim()) {
    vscode.window.showWarningMessage("当前 Python 文件为空，未提交");
    return;
  }

  const confirmation = await vscode.window.showInformationMessage(
    `提交 ${path.basename(document.fileName)} 到 ${selected.displayId} ${selected.title}？`,
    { modal: true },
    "提交评测",
  );
  if (confirmation !== "提交评测") return;

  try {
    const detail = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Neuro OJ · ${selected.displayId}`,
        cancellable: true,
      },
      async (progress, cancellation) => {
        progress.report({ message: "正在上传代码…" });
        const created = await api.submitCode(
          selected!.id,
          code,
          path.basename(document.fileName),
        );
        output.appendLine(`\n[提交] ${selected!.displayId} ${selected!.title}`);
        output.appendLine(`文件：${document.fileName}`);
        output.appendLine(`提交编号：${created.public_id ?? created.id}`);

        const config = vscode.workspace.getConfiguration("neuroOj");
        return await pollSubmission(() => api.submission(created.id), {
          intervalMs: config.get<number>("pollIntervalSeconds", 2) * 1000,
          timeoutMs: config.get<number>("pollTimeoutSeconds", 180) * 1000,
          isCancelled: () => cancellation.isCancellationRequested,
          onUpdate: (current) => {
            const queue =
              current.queue_position == null
                ? ""
                : `，队列第 ${current.queue_position} 位`;
            progress.report({
              message: `${statusLabel(current.status)}${queue}`,
            });
          },
        });
      },
    );
    showResult(detail);
  } catch (error) {
    await handleAuthenticatedError(context, error);
    showError("提交或评测失败", error);
  }
}

async function resolvePythonDocument(): Promise<
  vscode.TextDocument | undefined
> {
  const active = vscode.window.activeTextEditor?.document;
  if (
    active &&
    (active.languageId === "python" ||
      active.fileName.toLowerCase().endsWith(".py"))
  ) {
    return active;
  }

  const files = await vscode.workspace.findFiles(
    "**/submission.py",
    "**/{node_modules,.git,.venv,venv}/**",
    2,
  );
  if (files.length === 1) {
    const document = await vscode.workspace.openTextDocument(files[0]);
    await vscode.window.showTextDocument(document);
    return document;
  }
  if (files.length > 1) {
    const picked = await vscode.window.showQuickPick(
      files.map((uri) => ({
        label: vscode.workspace.asRelativePath(uri),
        uri,
      })),
      { title: "选择 submission.py" },
    );
    if (picked) return await vscode.workspace.openTextDocument(picked.uri);
    return undefined;
  }

  vscode.window.showWarningMessage(
    "请打开一个 Python 文件，或在工作区创建 submission.py",
  );
  return undefined;
}

function showResult(detail: SubmissionDetail): void {
  output.appendLine(`状态：${statusLabel(detail.status)}`);
  if (detail.result) {
    output.appendLine(`得分：${(detail.result.score / 100).toFixed(2)}`);
    if (detail.result.time_ms != null)
      output.appendLine(`耗时：${detail.result.time_ms} ms`);
    if (detail.result.memory_kb != null)
      output.appendLine(`内存：${detail.result.memory_kb} KiB`);
    if (detail.result.output) {
      output.appendLine("\n评测输出：");
      output.appendLine(detail.result.output);
      if (detail.result.output_truncated)
        output.appendLine("[输出已由服务端截断]");
    }
  }
  output.show(true);

  if (detail.status === "error") {
    vscode.window.showErrorMessage("Neuro OJ 评测失败，详情已写入输出面板");
  } else {
    const score = detail.result
      ? `${(detail.result.score / 100).toFixed(2)} 分`
      : "结果已完成";
    vscode.window.showInformationMessage(`Neuro OJ 评测完成：${score}`);
  }
}

async function handleAuthenticatedError(
  context: vscode.ExtensionContext,
  error: unknown,
): Promise<void> {
  if (error instanceof ApiError && error.status === 401) {
    await clearSession(context);
  }
}

function updateStatusBar(context: vscode.ExtensionContext): void {
  const selected =
    context.globalState.get<SelectedProblem>(SELECTED_PROBLEM_KEY);
  const user = context.globalState.get<User>(USER_KEY);
  statusBar.text = selected
    ? `$(cloud-upload) ${selected.displayId}`
    : user
      ? "$(cloud-upload) Neuro OJ"
      : "$(account) 登录 Neuro OJ";
  statusBar.command = user ? "neuroOj.submit" : "neuroOj.login";
}

async function setAuthenticated(value: boolean): Promise<void> {
  await vscode.commands.executeCommand(
    "setContext",
    "neuroOj.authenticated",
    value,
  );
}

function statusLabel(status: SubmissionDetail["status"]): string {
  return {
    pending: "等待评测",
    judging: "评测中",
    finished: "评测完成",
    error: "评测错误",
  }[status];
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError && error.requestId) {
    return `${error.message}（请求编号：${error.requestId}）`;
  }
  return error instanceof Error ? error.message : String(error);
}

function showError(prefix: string, error: unknown): void {
  const message = `${prefix}：${messageOf(error)}`;
  output.appendLine(`[错误] ${message}`);
  vscode.window.showErrorMessage(message, "查看输出").then((action) => {
    if (action === "查看输出") output.show(true);
  });
}

/** 每个服务器使用独立 SecretStorage 槽位，防止切换地址时向新站点发送旧 JWT。 */
function tokenKey(serverUrl: string): string {
  return `neuroOj.token:${serverUrl}`;
}

/** VS Code 扩展停用钩子。 */
export function deactivate(): void {}
