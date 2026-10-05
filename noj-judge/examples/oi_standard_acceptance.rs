//! 固定算法基准与跨进程一致性验收，不采集硬件耗时用于修改计量。
use noj_judge::{
    oi::{standard, wasm::evaluate_wasm, OiBackend},
    types::JudgeTask,
};
use std::collections::HashMap;
#[tokio::main]
async fn main() {
    let programs = [
        ("sort", "#include <algorithm>\n#include <iostream>\n#include <vector>\nint main(){std::vector<int>a;for(int i=1000;i>0;--i)a.push_back(i);std::sort(a.begin(),a.end());std::cout<<a.front()+a.back();}", "1001"),
        ("graph", "#include <iostream>\n#include <queue>\n#include <vector>\nint main(){std::vector<int>d(1000,1000000);std::priority_queue<std::pair<int,int>>q;d[0]=0;q.push({0,0});while(!q.empty()){int u=q.top().second;q.pop();if(u+1<1000&&d[u+1]>d[u]+1){d[u+1]=d[u]+1;q.push({-d[u+1],u+1});}}std::cout<<d[999];}", "999"),
        ("dp", "#include <iostream>\nint main(){long long a=0,b=1;for(int i=0;i<1000;i++){long long c=(a+b)%1000000007;a=b;b=c;}std::cout<<a;}", "517691607"),
        ("string", "#include <iostream>\n#include <string>\nint main(){std::string s(20000,'a');s+='b';std::cout<<s.find('b');}", "20000"),
        ("numeric", "#include <iostream>\nint main(){bool composite[20001]={};int count=0;for(int i=2;i<=20000;i++){if(!composite[i]){count++;for(int j=i*2;j<=20000;j+=i)composite[j]=true;}}std::cout<<count;}", "2262"),
        ("bulk-memory", "#include <iostream>\n#include <cstring>\nint main(){static unsigned char a[65536],b[65536];std::memset(a,7,sizeof(a));std::memcpy(b,a,sizeof(a));unsigned sum=0;for(auto c:b)sum+=c;std::cout<<sum;}", "458752"),
        ("wrong-answer", "#include <iostream>\nint main(){std::cout<<0;}", "42"),
        ("fuel-limit", "int main(){for(;;){}}", "42"),
    ];
    let mut reports = Vec::new();
    for (name, source, expected) in programs {
        let mut task: JudgeTask = serde_json::from_str(include_str!(
            "../../noj-tests/fixtures/judge-task-oi.contract.json"
        ))
        .unwrap();
        task.code = source.into();
        task.language = "cc".into();
        task.oi_cost_profile = Some(standard::profile());
        let mut config = task.runtime_config.as_oi().unwrap().clone();
        config.backend = OiBackend::Wasm;
        if name == "fuel-limit" {
            config.time_limit_ms = 10;
        }
        let cases = vec![(
            "testdata/1.in".into(),
            Vec::new(),
            expected.as_bytes().to_vec(),
        )];
        let empty = HashMap::new();
        let result = evaluate_wasm(
            &task,
            &config,
            &cases,
            &standard::profile(),
            None,
            &empty,
            &empty,
            &empty,
        )
        .await
        .unwrap();
        let verdict = match name {
            "wrong-answer" => "WA",
            "fuel-limit" => "TLE",
            _ => "AC",
        };
        assert_eq!(
            result.details["oi"]["verdict"], verdict,
            "{name}: {:?}",
            result.details
        );
        assert_eq!(result.details["metering"]["comparable"], true);
        let case = &result.details["oi"]["subtasks"][0]["cases"][0];
        if name == "fuel-limit" {
            assert_eq!(case["fuel_consumed"], case["fuel_budget"]);
        }
        reports.push(serde_json::json!({"name":name,"verdict":verdict,"fuel_consumed":case["fuel_consumed"],"fuel_budget":case["fuel_budget"],"metering":result.details["metering"]}));
    }
    println!("{}", serde_json::to_string_pretty(&reports).unwrap());
}
