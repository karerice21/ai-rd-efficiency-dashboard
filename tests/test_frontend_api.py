import io
import zipfile
from xml.etree import ElementTree

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(Settings(database_path=tmp_path / "ui.sqlite3"))) as c: yield c


def test_retained_frontend_assets_and_data_contract(client):
    for path in ['/', '/app.js', '/styles.css', '/favicon.svg', '/login', '/login.css', '/workspace']:
        assert client.get(path).status_code == 200
    projects=client.get('/api/dashboard/projects').json()
    assert len(projects)==6 and isinstance(projects[0]['id'],int)
    result=client.get('/api/dashboard/overview',params={'start':'2026-10-01','end':'2026-10-30'}).json()
    expected=client.get('/api/dashboard',params={'start':'2026-10-01','end':'2026-10-30'}).json()
    assert result['summary']['total_tokens']==expected['kpis']['tokens']
    assert result['summary']['added_lines']==expected['kpis']['additions']
    assert len(result['project_code_ranking'])==6
    assert sum(r['total_tokens'] for r in result['period_token_trend'])==result['summary']['total_tokens']
    assert result['data_source']['label'].startswith('虚构')


@pytest.mark.parametrize('grain',['week','biweek','month','quarter'])
def test_frontend_multiselect_periods(client,grain):
    result=client.get('/api/dashboard/overview',params=[('start','2026-10-01'),('end','2026-10-30'),('teams','星云研发一部'),('project_ids','1'),('granularity',grain)]).json()
    assert result['summary']['monitor_project_count']==1
    assert result['project_code_ranking'][0]['project_id']==1
    assert all(r['period_start']<=r['period_end'] for r in result['period_token_trend'])


def test_frontend_management_multiple_repos_and_history(client):
    payload={'name':'虚构新增项目','team':'演示团队','project_locations':['https://example.com/orbit-demo/one.git','https://example.com/orbit-demo/two.git']}
    response=client.post('/api/project-management/projects',json=payload)
    assert response.status_code==200
    p=response.json(); assert p['repository_count']==2
    assert client.get(f"/api/dashboard/projects/{p['id']}").status_code==200
    assert client.post(f"/api/project-management/projects/{p['id']}/stop").json()['monitoring_status']=='STOPPED'
    assert client.post(f"/api/project-management/projects/{p['id']}/resume").json()['monitoring_status']=='ACTIVE'
    assert client.post(f"/api/project-management/projects/{p['id']}/rematch").status_code==200
    assert client.put(f"/api/project-management/projects/{p['id']}",json={**payload,'name':'虚构更名项目'}).json()['name']=='虚构更名项目'
    # Logical deletion leaves stored statistics intact.
    with client.app.state.store.connect() as db: count=db.execute('SELECT COUNT(*) FROM usage').fetchone()[0]
    assert client.delete('/api/project-management/projects/1').json()['historical_data_retained']
    with client.app.state.store.connect() as db: assert db.execute('SELECT COUNT(*) FROM usage').fetchone()[0]==count
    assert all(p['id']!=1 for p in client.get('/api/dashboard/projects').json())


def test_code_csv_import_and_dedup(client):
    body=b'project_id,sha,day,additions,author\nP001,fictional-sha,2026-10-15,100,fictional-contributor\n'
    result=client.post('/api/code-stat/import',files={'file':('fictional.csv',body)}).json()
    assert result['inserted_daily_count']==1
    assert client.post('/api/code-stat/import',files={'file':('fictional.csv',body)}).json()['status']=='DUPLICATE_FILE'
    assert client.post('/api/code-stat/import',files={'file':('fictional.csv',b'bad\n')}).status_code==422
    workbook=client.get('/api/template/ledger.xlsx').content
    assert client.post('/api/code-stat/import',files={'file':('fictional.xlsx',workbook)}).json()['updated_daily_count']==6


def test_quota_snapshot_and_no_paid_calls(client):
    snapshot=client.get('/api/coding-plan/quotas').json()
    assert all('虚构' in s['name'] and s['console_url'].startswith('https://example.com') for s in snapshot['snapshots'])
    assert client.post('/api/coding-plan/refresh').json()==snapshot
    assert client.get('/api/model-speed/targets').json()['enabled'] is False
    assert client.post('/api/litellm/sync').json()['upserted_row_count']==0
    assert client.post('/api/auth/login',json={'username':'fictional-user','password':'placeholder-only'}).json()['authenticated'] is False


def test_report_exports(client):
    pdf=client.get('/api/dashboard/report?format=pdf')
    assert pdf.status_code==200 and pdf.content.startswith(b'%PDF-1.4')
    assert b'xref' in pdf.content and pdf.content.rstrip().endswith(b'%%EOF')
    docx=client.get('/api/dashboard/report?format=docx')
    assert docx.status_code==200
    with zipfile.ZipFile(io.BytesIO(docx.content)) as z:
        root=ElementTree.fromstring(z.read('word/document.xml'))
        assert '星轨知识助手' in ''.join(root.itertext())
    assert client.get('/api/dashboard/report?format=invalid').status_code==422
