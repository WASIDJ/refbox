# RefBox (自指箱)

> **Dynamic Box-Framing & Recursive Self-Improvement (RSI) Engine**  
> 模拟并千倍加速人类“不断构建箱子、现实碰撞、破裂升维、解决问题”的递归认知演化实验引擎。

```
  ██████╗ ███████╗███████╗██████╗  ██████╗ ██╗  ██╗
  ██╔══██╗██╔════╝██╔════╝██╔══██╗██╔═══██╗╚██╗██╔╝
  ██████╔╝█████╗  █████╗  ██████╔╝██║   ██║ ╚███╔╝ 
  ██╔══██╗██╔══╝  ██╔══╝  ██╔══██╗██║   ██║ ██╔██╗ 
  ██║  ██║███████╗██║     ██████╔╝╚██████╔╝██╔╝ ██╗
  ╚═╝  ╚═╝╚══════╝╚═╝     ╚═════╝  ╚═════╝ ╚═╝  ╚═╝
```

---

## 一、 为什么构建 RefBox？（哲学与理论基石）

人类文明有史以来的所有智力突破——从算术、欧几里得几何、牛顿力学，到微服务、分布式共识和现代法治——**本质上只有一件事：在无边无际的混沌宇宙中，划定一道界限，制造一个“箱子（Box）”，把问题关进有限边界内解决；一旦箱子破裂，就在箱子外面再套一个更大的箱子。**

现在的 LLM 之所以频繁在复杂任务中幻觉、陷入死循环，是因为它缺乏**“造箱子的自觉”**——试图在一个无限的上下文中用概率生成撞大运。

`RefBox` 是一个基于 **二阶控制论、自指认识论与复杂系统科学** 的全新 Go 语言认知引擎。它将以下七大理论收敛为一套可执行的计算状态机：

```mermaid
flowchart TD
    Chaos["混沌世界 / 原始目标 (Problem Space)"] --> Frame["1. 划界造箱 (Spencer-Brown Distinction)<br/>定义 InScope / OutScope / Invariants"]
    Frame --> Solve["2. 操作闭合推演 (Maturana Autopoiesis)<br/>在有限边界内探寻局部自洽解"]
    Solve --> Collide["3. 现实碰撞 (Peirce Secondness)<br/>沙盒 / 编译 / 测试的残酷阻抗"]
    Collide -->|通过 (Held)| Crystal["4a. 黑箱固化 (Encapsulation)<br/>成为不可变可靠资产，沉淀为新 Tool"]
    Collide -->|破裂 (Fractured)| Observe["4b. 二阶观察 (Von Foerster / Luhmann)<br/>诊断盲点: 是操作手滑还是边界画错?"]
    Observe -->|边界破裂| Meta["5. 元系统跃迁 (Metasystem Transition)<br/>套上更大的父级箱子，内化盲点重构"]
    Meta --> Solve
```

### 理论谱系：
1. **形式的法则（G. Spencer-Brown）**：*"Draw a distinction."*（划出一道区分）。任何问题的求解，始于划定边界，而非搜寻答案。
2. **自创生理论（H. Maturana & F. Varela）**：操作闭合（Operational Closure）。箱子内部必须依据自身不变量运作，不依赖外部微观指挥。
3. **实用主义（C.S. Peirce）**：第二性（Secondness / 粗暴的阻抗）。现实不是镜子，现实是会撞痛我们的墙。碰撞产生的错误不是 Bug，而是通往真理的必要摩擦。
4. **二阶控制论（H. von Foerster & N. Luhmann）**：二阶观察（Second-Order Observation）。当系统受挫时，观察“观察者自身的盲点”，区分“箱内操作失误”与“箱子假设破裂”。
5. **元系统跃迁（V. Turchin & G. Weinberg）**：白箱演化为黑箱，破裂的箱子被嵌套为更高阶元箱的内部变量。这是广义 RSI（递归自优化）的核心动力学。

---

## 二、 核心架构

```
refbox/
├── cmd/
│   └── refbox/              # CLI 命令行入口 (manifesto, demo, run)
├── pkg/
│   ├── box/                 # 箱子抽象与生命周期状态机 (Boundary, State, Box)
│   ├── collision/           # 现实碰撞与第二性阻抗 (Verifier, Shell, Predicate)
│   ├── observer/            # 二阶观察与盲点诊断 (SecondOrderObserver, Diagnosis)
│   ├── agent/               # 认知解题主体接口 (Frame, SolveInBox, Reframe)
│   └── engine/              # 递归造箱与广义 RSI 调度内核 (Engine, Event Loop)
└── examples/                # 认知升维与箱子破裂重构集成测试
```

### 状态机生命周期（Box States）
* `FORMING`：划界算子确立，制定契约与不变量。
* `SOLVING`：在操作闭合的极窄上下文中高速推导。
* `COLLIDING`：将假设推向外部 Verifier 接受现实摩擦。
* `FRACTURED`：现实击穿了假设，二阶观察介入暴露盲点。
* `CRYSTALLIZED`：假设经受住了物理考验，箱子结晶为不可变的黑箱组件。

---

## 三、 快速上手

### 1. 编译
```bash
go build -o bin/refbox ./cmd/refbox
```

### 2. 运行认知演化实验（Demo）
演示 Agent 从单机互斥锁（Level 0 破裂）到分布式 Raft 共识（Level 2 结晶）的完整升维过程：
```bash
./bin/refbox demo
```

输出示例：
```text
[20:56:19.427] Level 0 | BOX_FRAMED -> Initial bounded hypothesis for: Build a distributed counter
[20:56:19.427] Level 0 | SOLVING_IN_BOX -> Attempt 1/3
[20:56:19.427] Level 0 | COLLIDING -> Friction against verifier: PartitionChaosVerifier
[20:56:19.427] Level 0 | FRACTURED -> [BOUNDARY_FRACTURE] Assumption 'environment_is_static' collided with NETWORK_PARTITION_ERROR
[20:56:19.427] Level 0 | METASYSTEM_TRANSITION -> Escalating to Level 1
  [20:56:19.427] Level 1 | NEW_BOX_SPAWNED -> Metasystem Level 1: Internalizing partition reality
  ...
    [20:56:19.429] Level 2 | CRYSTALLIZED -> Box boundary held against reality; solution verified.

>>> Experiment Succeeded! Final Crystallized Box ID: box-L2-distributed-consensus
```

### 3. 查看认识论宣言
```bash
./bin/refbox manifesto
```

### 4. 运行测试
```bash
go test -v ./...
```

---

## 四、 极简代码示例

```go
package main

import (
	"context"
	"fmt"
	"github.com/WASIDJ/refbox/pkg/agent"
	"github.com/WASIDJ/refbox/pkg/collision"
	"github.com/WASIDJ/refbox/pkg/engine"
	"github.com/WASIDJ/refbox/pkg/observer"
)

func main() {
	// 1. 定义现实摩擦裁判（Verifier）
	verifier := collision.NewCommandVerifier("GoTestVerifier", "go test ./...", "", 0)

	// 2. 装配认知 Agent 与二阶观察者
	ag := agent.NewHeuristicAgent("WorkerAgent", nil, nil)
	obs := observer.NewHeuristicObserver()

	// 3. 启动自进化引擎
	eng := engine.NewEngine(ag, verifier, obs, 5)
	
	resultBox, err := eng.Solve(context.Background(), "Implement resilient caching")
	if err != nil {
		panic(err)
	}

	fmt.Printf("Crystallized Box: %s (Level %d)\n", resultBox.ID, resultBox.Level)
}
```

---

## 五、 开源与许可证

MIT License. Designed for Recursive Self-Improvement experiments.
