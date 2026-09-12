import * as vscode from "vscode";
import type { Problem, SelectedProblem } from "./types";

/** Neuro OJ 题目侧边栏数据源。 */
export class ProblemsTreeProvider implements vscode.TreeDataProvider<ProblemItem> {
  private readonly changed = new vscode.EventEmitter<ProblemItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private problems: Problem[] = [];
  private selected: SelectedProblem | undefined;
  private message = "请先登录 Neuro OJ";

  setLoading(): void {
    this.problems = [];
    this.message = "正在加载题目…";
    this.changed.fire(undefined);
  }

  setProblems(
    problems: Problem[],
    selected: SelectedProblem | undefined,
  ): void {
    this.problems = problems;
    this.selected = selected;
    this.message = problems.length === 0 ? "暂无可提交的代码题" : "";
    this.changed.fire(undefined);
  }

  setMessage(message: string): void {
    this.problems = [];
    this.message = message;
    this.changed.fire(undefined);
  }

  markSelected(selected: SelectedProblem): void {
    this.selected = selected;
    this.changed.fire(undefined);
  }

  getTreeItem(element: ProblemItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ProblemItem[] {
    if (this.problems.length === 0) {
      return this.message ? [ProblemItem.message(this.message)] : [];
    }
    return this.problems.map((problem) =>
      ProblemItem.problem(problem, this.selected?.id === problem.id),
    );
  }
}

export class ProblemItem extends vscode.TreeItem {
  private constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
  }

  static message(label: string): ProblemItem {
    const item = new ProblemItem(label);
    item.iconPath = new vscode.ThemeIcon("info");
    return item;
  }

  static problem(problem: Problem, selected: boolean): ProblemItem {
    const item = new ProblemItem(`${problem.display_id} · ${problem.title}`);
    item.description = selected
      ? "当前题目"
      : difficultyLabel(problem.difficulty);
    item.tooltip = `${problem.display_id} ${problem.title}`;
    item.contextValue = "neuroOj.problem";
    item.iconPath = new vscode.ThemeIcon(selected ? "check" : "book");
    item.command = {
      command: "neuroOj.selectProblem",
      title: "选择题目",
      arguments: [problem],
    };
    return item;
  }
}

function difficultyLabel(value: string): string {
  return (
    ({ easy: "简单", medium: "中等", hard: "困难" } as Record<string, string>)[
      value
    ] ?? value
  );
}
