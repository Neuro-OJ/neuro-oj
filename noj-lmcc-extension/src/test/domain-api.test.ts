import assert from 'node:assert/strict';
import test from 'node:test';
import { NeuroOjApi, type HttpRequest } from '../api';

test('共享题代码提交与读取始终使用目标域，不使用源域', async () => {
  const requests: HttpRequest[] = [];
  const api = new NeuroOjApi('https://noj.example.com', 5000, async (request) => {
    requests.push(request);
    return { status: 200, headers: {}, body: JSON.stringify({ data: { id: 'submission', status: 'pending' } }) };
  });
  api.setToken('token');
  await api.submitDomainCode('school', 'main:1001', 'print(1)', 'solution.py', 'version-1');
  await api.domainSubmission('school', 'submission');
  assert.equal(requests[0].url.pathname, '/api/v1/domains/school/submissions');
  assert.deepEqual(JSON.parse(requests[0].body!), {
    problem_ref: 'main:1001', version_id: 'version-1', language: 'python3', code: 'print(1)', file_name: 'solution.py',
  });
  assert.equal(requests[1].url.pathname, '/api/v1/domains/school/submissions/submission');
});
test('域题库和默认版本读取使用显式域契约', async () => {
  const requests: HttpRequest[] = [];
  const api = new NeuroOjApi('https://noj.example.com', 5000, async (request) => {
    requests.push(request);
    const value = request.url.search ? { items: [{ reference: { display_ref: 'main:1001' }, title: '共享题', kind: 'ai' }], total: 1 }
      : { version_id: 'version', version: 3, content: { title: '共享题' } };
    return { status: 200, headers: {}, body: JSON.stringify(value) };
  });
  api.setToken('token');
  const list = await api.domainProblems('school');
  assert.equal(list[0].display_id, 'main:1001');
  assert.equal((await api.domainProblem('school', list[0].id)).version, 3);
  assert.equal(requests[1].url.pathname, '/api/v1/domains/school/problems/main%3A1001');
});
