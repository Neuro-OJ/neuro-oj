/** 管理员开号 CSV 的三列数据。空邮箱和密码由服务端生成。 */
export interface AccountCsvRow {
  username: string;
  email?: string;
  password?: string;
}

/** 解析含表头的 CSV，支持 BOM、CRLF、引号、转义引号与引号内换行。 */
export function parseAccountCsv(source: string): AccountCsvRow[] {
  const text = source.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  const endRecord = () => {
    record.push(field);
    // 只忽略真正的空白行；",," 仍是一行，应交由服务端报告缺失用户名。
    if (record.length > 1 || record[0] !== '') records.push(record);
    record = [];
    field = '';
    closedQuote = false;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
        closedQuote = true;
      } else field += char;
    } else if (char === ',') {
      record.push(field);
      field = '';
      closedQuote = false;
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      endRecord();
    } else if (char === '"' && field === '' && !closedQuote) {
      quoted = true;
    } else {
      if (closedQuote || char === '"') throw new Error(`第 ${records.length} 行 CSV 引号格式错误`);
      field += char;
    }
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  endRecord();
  const header = records.shift();
  if (!header || header.map((value) => value.trim()).join(',') !== 'username,email,password') {
    throw new Error('CSV 表头必须为 username,email,password');
  }
  if (records.length < 1 || records.length > 500) throw new Error('每次必须导入 1-500 行账号');
  return records.map((values, index) => {
    if (values.length !== 3) throw new Error(`第 ${index + 1} 行必须包含 username,email,password 三列`);
    const [username = '', email = '', password = ''] = values;
    return { username, email: email || undefined, password: password || undefined };
  });
}

/** 只在浏览器本地把本次返回的凭据序列化，不再请求服务端。 */
export function credentialsCsv(rows: AccountCsvRow[]): string {
  const escape = (value: string) => `"${value.replaceAll('"', '""')}"`;
  return '\uFEFFusername,email,password\r\n' +
    rows.map((row) => [row.username, row.email ?? '', row.password ?? ''].map(escape).join(',')).join('\r\n');
}
