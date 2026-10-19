# 模型调用价格

> 模型调用默认 按量计费 ，涵盖各类模型的计费规则与价格。

<Note>
  部分模型支持<strong>上下文缓存</strong>（显式缓存、隐式缓存）。缓存命中的输入 Token 及创建显式缓存的 Token 采用与标准输入不同的计费单价（例如显式缓存创建按标准输入单价的 125% 计费、命中按 10% 计费），本文价格表中的输入单价<strong>不含</strong>缓存单价。缓存的计费规则、单价折扣及支持的模型请参见[上下文缓存](/zh/model-studio/context-cache)。
</Note>

## 阶梯计费规则

百炼部分模型实行阶梯计费。单价取决于单次请求的输入 Token 总量。

## 文本生成-千问

### 千问Max <span id="max-anchor" />

计费规则：按输入Token和输出Token计费。

<Tabs>
  <Tab title="华北2（北京）">
    <table style={{ display: "table", tableLayout: "fixed", width: "100%" }}>
      <thead>
        <tr>
          <th style={{ verticalAlign: "top" }}><strong>模型 ID（Model ID）</strong></th>
          <th style={{ verticalAlign: "top" }}><strong>模式</strong></th>
          <th style={{ verticalAlign: "top" }}><strong>单次请求的输入Token数</strong></th>
          <th style={{ verticalAlign: "top" }}><strong>输入单价（每百万Token）</strong></th>
          <th style={{ verticalAlign: "top" }}><strong>输出单价（每百万Token）</strong></th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.8-max

            > [上下文缓存](/zh/model-studio/context-cache)享有折扣
          </td>
          <td style={{ verticalAlign: "top" }}><p>非思考和思考模式</p></td>
          <td style={{ verticalAlign: "top" }}><p>0\<Token≤128K</p></td>
          <td style={{ verticalAlign: "top" }}><p>1.6<span class="help-letter-space"></span>元</p></td>
          <td style={{ verticalAlign: "top" }}><p>6.4<span class="help-letter-space"></span>元</p></td>
        </tr>
      </tbody>
    </table>
  </Tab>
</Tabs>

### 千问Flash <span id="flash-anchor" />

计费规则：按输入Token和输出Token计费。

影响计费的因素：若模型支持[Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)，其输入和输出Token单价均按实时推理价格的50%计费；若模型支持[上下文缓存](/zh/model-studio/context-cache)，仅输入Token享有折扣。两者不能同时生效。

<Note>
  以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。
</Note>

<Tabs>
  <Tab title="华北2（北京）">
    <table style={{ display: "table", tableLayout: "fixed", width: "100%" }}>
      <thead>
        <tr>
          <th style={{ verticalAlign: "top" }}><strong>模型 ID（Model ID）</strong></th>
          <th style={{ verticalAlign: "top" }}><strong>模式</strong></th>
          <th style={{ verticalAlign: "top" }}><strong>单次请求的输入Token数</strong></th>
          <th style={{ verticalAlign: "top" }}><strong>输入单价（每百万Token）</strong></th>
          <th style={{ verticalAlign: "top" }}><strong>输出单价（每百万Token）</strong></th>
          <th style={{ verticalAlign: "top" }}>
            <strong>免费额度</strong>[（注）](/zh/model-studio/new-free-quota#977b13081ab56)
          </th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.8-flash

            > [上下文缓存](/zh/model-studio/context-cache)享有折扣
          </td>
          <td style={{ verticalAlign: "top" }}><p>非思考和思考模式</p></td>
          <td style={{ verticalAlign: "top" }}><p>0\<Token≤1M</p></td>
          <td style={{ verticalAlign: "top" }}><p>0.8<span class="help-letter-space"></span>元</p></td>
          <td style={{ verticalAlign: "top" }}><p>2.7<span class="help-letter-space"></span>元</p></td>
          <td style={{ verticalAlign: "top" }}><p>100万Token</p></td>
        </tr>
        <tr>
          <td rowspan="2" style={{ verticalAlign: "top" }}>
            qwen3.7-flash

            > 当前能力等同于qwen3.7-flash-2026-07-15

            > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价
          </td>
          <td rowspan="2" style={{ verticalAlign: "top" }}><p>非思考和思考模式</p></td>
          <td style={{ verticalAlign: "top" }}><p>0\<Token≤32K</p></td>
          <td style={{ verticalAlign: "top" }}><p>0.2元</p></td>
          <td style={{ verticalAlign: "top" }}><p>0.8元</p></td>
          <td rowspan="2" style={{ verticalAlign: "top" }}><p>100万Token</p></td>
        </tr>
        <tr>
          <td style={{ verticalAlign: "top" }}><p>32K\<Token≤256K</p></td>
          <td style={{ verticalAlign: "top" }}><p>0.6元</p></td>
          <td style={{ verticalAlign: "top" }}><p>2.4元</p></td>
        </tr>
      </tbody>
    </table>
  </Tab>
  <Tab title="新加坡">
    <table style={{ display: "table", tableLayout: "fixed", width: "100%" }}>
      <thead>
        <tr>
          <th style={{ verticalAlign: "top" }}><strong>模型 ID（Model ID）</strong></th>
          <th style={{ verticalAlign: "top" }}><strong>单次请求的输入Token数</strong></th>
          <th style={{ verticalAlign: "top" }}><strong>输入单价（每百万Token）</strong></th>
          <th style={{ verticalAlign: "top" }}><strong>输出单价（每百万Token）</strong></th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style={{ verticalAlign: "top" }}>qwen3.8-flash</td>
          <td style={{ verticalAlign: "top" }}>0\<Token≤1M</td>
          <td style={{ verticalAlign: "top" }}>1.094元</td>
          <td style={{ verticalAlign: "top" }}>3.427元</td>
        </tr>
      </tbody>
    </table>
  </Tab>
</Tabs>

### 千问Omni <span id="omni-anchor" />

#### 华北2（北京）

<table style={{ display: "table", tableLayout: "fixed", width: "100%" }}>
  <thead>
    <tr>
      <th style={{ verticalAlign: "top" }}><strong>模型 ID（Model ID）</strong></th>
      <th style={{ verticalAlign: "top" }}><strong>服务部署范围</strong></th>
      <th style={{ verticalAlign: "top" }}><strong>输入单价（每百万Token）</strong></th>
      <th style={{ verticalAlign: "top" }}><strong>缓存命中输入单价（每百万Token）</strong></th>
      <th style={{ verticalAlign: "top" }}><strong>输出单价（每百万Token）</strong></th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td style={{ verticalAlign: "top" }}>qwen3.8-omni-flash</td>
      <td style={{ verticalAlign: "top" }}>中国内地</td>
      <td style={{ verticalAlign: "top" }}>0.8元</td>
      <td style={{ verticalAlign: "top" }}>0.1元</td>
      <td style={{ verticalAlign: "top" }}>2.7元</td>
    </tr>
  </tbody>
</table>

### 千问Long <span id="long-anchor" />

<table>
  <thead>
    <tr>
      <th>模型 ID（Model ID）</th>
      <th>输入单价（每百万Token）</th>
      <th>输出单价（每百万Token）</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>qwen-long</td>
      <td>0.5元</td>
      <td>2元</td>
    </tr>
  </tbody>
</table>
