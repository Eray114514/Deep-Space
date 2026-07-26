# 深空 优化路线图

> ⚠️ 重要说明:本文档记录基于用户痛点整理的全面优化方案。核心原则:**全面优化,接受宇宙锁重做**。既然母星要单星、半径要放大、noise/height 要改,锁一定会失效,那就放开手按子系统全面优化,最后一次性 re-curation,不被"不破坏锁"束缚。

---

## ⚠️ 重要说明:根因均为推测,未经深度排查验证

本文档中所有"推测根因"都是基于代码阅读和理论分析得出的初步推测,**未经深度排查验证**。在按推测根因实施前,执行者应自行确认根因，如发现推测根因错误,更新本文档并重新规划。

各子系统列出的"建议验证方向"是**参考**,不是硬性 checklist——执行者根据问题性质自行判断需要做到哪一步。

严禁在根因未确认的情况下,仅凭本文档的推测就按计划执行——根因错了,改动就治标不治本甚至白改。

本文档的优化方向是基于推测根因的**候选方向**,不是定论。实施时以实际验证为准,执行者有更优方案时可偏离本文档。

---

## 0. 用户痛点清单

| # | 子系统 | 痛点 |
|---|---|---|
| 1 | 地形 LOD | 远看近看不是一个东西,切换明显;太空看特别丑;山脊锯齿;地形板块散乱;几何边缘锯齿 |
| 2 | 光照大气 | 光照不够细腻;日落不够美;背阳面一片黑;大气不真实且没有变化 |
| 3 | 水体 | 平面感不真实;沙滩衔接怪、固定一条线;无飞船交互;无海洋星球/波涛汹涌;水+光+大气+云无联动 |
| 4 | 音效 | 飞船引擎音嗡嗡嗡像劣质飞机,难听吵闹 |
| 5 | 星系 | 双星过多(实测 31-33%,但母星本身是双星);黑洞周围恒星过近;星球半径偏小、大气偏厚 |
| 6 | 材质植被 | 无岩石材质(单色 tint);草像杂草非草地;树低模;沙滩衔接差;雪线固定海拔横线划分 |
| 7 | 星环 | 太假(256×1 贴图、不响应光照、无阴影) |
| 8 | 天气 | 有大气但无天气系统 |

### 用户原提示词

> 项目目前现状： 
 地面不行：lod太烂。远看近看不是一个东西，切换明显，且远的形态，尤其太空看，看到的特别丑，近处看还好。 
 光照不行：1是光照不好看，不够细腻，这个也是和大气有一点关联，光照+大气=我可以看到很美的日落效果。但是现在光照就是有点简单。 
 还有就是一个星球如果本来就很黑，还是背阳面，我开过去真的啥都看不到，真的一片黑，这个是问题。 
 水体不行：1是水本身效果不好，不真实，就是个平面，和陆地边缘的衔接也特别怪，就是固定的一条线。2是我也希望水加点动态交互，比如飞船贴着水开会有那种效果等等。水也可以和光照+大气形成交互，让我看到很美的水+天+云+日落效果。3是似乎没有那种很多水的星球？或者波涛非常汹涌，或者比较潜的水的的海洋星球？（不是全海，有陆地，较少而已） 
 程序化音效很难听，尤其是这个飞船，声音和劣质飞机一样，嗡嗡嗡的，难听很吵还没有飞船的感觉。 
 双恒星系统过多了，几乎全是双星。 
 黑的周围这么近有恒星？合理吗？ 
 星球世界本身不合理，大气的高度，地面看云层高度，这个还行，但是太空看：星球半径和大气厚度应该是什么比例？项目肯定不是这个比例，到底大气足够高但是星球有点小了。但是readme又说是真实行星大小？就说母星我怎么感觉还是挺小的呢？ 
 但是光加半径不管探索肯定不行，不然会导致飞船离星球太远开进去要很久。 
 有些地形边缘过于几何化了，远看完全是锯齿边缘。雪山的山脊也会出现有些山脊完全是锯齿而不是一条线。 
 宜居行星完全固定海拔积雪，导致一堆山完全横线划分上面就是雪。 
 山脉的岩石也不应该是个平面，如果有岩石纹理和更真实的岩石效果会更好，我很喜欢这种非常高的山能生成出来，但是现在的问题是只能远看。不过现在好像是不是根本没有岩石这种材质，只有草地，雪山和沙滩。 
 有大气但没有大气变化，没有天气系统。 
 现在的草只能算杂草模型而不是草模型。我的意思是那种特别密集的草地，非常多的一根根的草。 
 树也有点低模。那种接近才加载的发光植物明明还行但是树简直太低质量了格格不入。 
 沙滩和还有衔接很差。 
 体积云还行（但是也需要优化）但是大气有点不太行，参考我给的文件重做一下。
 地形还行但是有点“散”，虽然抽也能抽中形态比较好的，但是宜居星球那么多总有板块很散很难看的，我也不是说不能散，可以有那种几乎全是海洋的星球但是起码母星不能散，不然难看。 
 还有星环效果，太假了。 

## 一、宇宙锁影响边界

### 1.1 锁的核心契约

`worlds/milky-way.lock.json` 由 `tools/canonical-world.js:199 buildCanonicalWorldLock()` 生成,记录:
- `identity` / `generatorVersions` / `authoredConfig` / `finiteCatalog`(1024 系统 + 内层指纹)
- `homeSystem`(母星完整档案:stars/binaryOrbit/bodies 全字段)
- `specialDestinations` / `civilizationSites` / `nearbySystems` / `neighborhoodProfile`
- `homeSurfaceSentinels`:`naturalSeaLevel`/`tunedSeaLevel`/`cloudCoverage`/`hasRing`/`mountMaskLo` + 4 方向 `heightSamples`
- 顶层 `fingerprintSha256`(SHA-256 覆盖以上所有字段,`JSON.stringify` 对键顺序和浮点位级敏感)

`npm test` 用 `assert.deepStrictEqual` 位级比对。任何字段(包括两层指纹)的位级差异都会触发失败。

### 1.2 破坏锁的改动(走 re-curation 流程)

既然全面优化,以下改动都会破坏锁,统一在最后一次性 re-curation:

| 改动 | 位置 | 破坏原因 |
|---|---|---|
| noise.js Simplex/fbm/ridged 算法 | `src/noise.js` | sentinel `height()` 变 |
| planet.js height() 内常数 | `src/planet.js:279-377` | sentinel 变 |
| planet.js 构造器 rand() 序列 | `src/planet.js:100-178` | RNG 流错位 |
| 双星率(母星单星) | `src/astronomy.js:119` `binaryChance` | `homeSystem.stars` 变 |
| 黑洞周围最小距离 | `src/galaxy-layout.js:63` `regionPosition` | `finiteCatalog.positionCells` 变 |
| 星球半径放大 | `src/astronomy.js:414-416` | `body.radius` + `hAmp`→sentinel + `rocheRadius`→ringSystem 全变 |
| TYPES.relief 调整 | `src/planet.js:35-43` | `hAmp`→sentinel 变 |
| buildPalette stops 数量 | `src/planet.js:514-579` | 每个 stop 调 `J()` 消费 `rand()` |
| 新增行星 type | `src/planet.js:35` + `src/galaxy-layout.js` | RNG 序列变 |

### 1.3 不破坏锁的改动(可独立做,但既然全面优化可并行)

| 改动 | 位置 | 说明 |
|---|---|---|
| LOD 调度参数 | `src/quadtree.js` SPLIT/MERGE/MORPH_TIME/orbitLevelCap | 纯渲染调度 |
| 光照参数 | `src/galaxy.js:557`/`src/main.js:174,2323,2347` | 渲染参数 |
| 大气 shader | `src/atmosphere-webgl.js` 全文 | 纯 shader |
| 水 shader | `src/shaders-webgl.js:421-484` `applyWaterWaves` | 纯 onBeforeCompile |
| 沙滩过渡 shader | fragment 分支(不新增 uniform) | 不改 `colorAt` CPU 输出 |
| 星环 shader 化 | `src/planet.js:877-881`(保留 RNG 调用) | 只改材质,不增删 `rand()` |
| 植被几何/密度 | `src/flora.js`/`src/scatter.js` | `planet.seed+':flora'` 与 `intSeed^0x5ca7` 独立 namespace |
| 音效 | `src/audio.js` 全文 | `audio:noise:v1` 独立 namespace |
| 雪线 shader | per-fragment(已是 shader) | 不改 `pal.snowLine` 的 `rand()` 次数 |
| 岩石材质 shader | fragment 加法线/粗糙度(仅用已有 uniform) | 不改 `colorAt` |

### 1.4 灰色地带(值变但 RNG 不变,锁文件不变但视觉变)

- `atmoFraction` 常量值改动(`src/planet.js:110`):`rand()` 仍调用,锁文件不变,但大气变薄——文档化即可
- `TYPES` 表颜色 hex 改动:不进 RNG,锁不变,但所有同型行星外观变——文档化

---

## 二、子系统优化方向

### 2.1 地形 LOD 与噪声

#### 现状与推测根因(仅供参考,待验证)

- **LOD 机制**:`src/quadtree.js` cube-sphere 四叉树,`SPLIT=4.0/MERGE=5.2` 固定距离阈值,**不考虑地形粗糙度**(推测:粗糙山脊远距分裂不足 → 太空看像低多边形)。
- **太空丑推测根因**:飞行模式下 `orbitLevelCap=1-2`(`src/planet.js:215`),level 1-2 的 chunk 在 24×24 网格上采样,maxFreq 被压到很低,台地/峡谷等中频细节不参与。没有独立轨道 impostor。
- **山脊锯齿推测根因**:`src/noise.js` Simplex 用固定 12 梯度向量(GRAD 数组),球面采样某些方向可能有 bias,`ridged` 的 `1-|n|` 平方可能放大 bias → 锯齿脊(`src/planet.js:299-303`)。**注意**:这只是理论推测,实际锯齿可能源于 morph target 不一致、maxFreq 硬切断、或 simplex 网格方向性,需实验验证。
- **地形散乱推测根因**:`src/planet.js:285` `belt = smoothstep(...)` 省份掩码是硬 smoothstep,边界是等值线;`mMask = ...*(0.12+0.88*belt)`(`src/planet.js:299`)山只在 belt 区出现,belt 边界可能是山的硬边。
- **几何边缘推测根因**:推测是 noise 本身问题(非 LOD 接缝,skirt 已遮挡),但需验证是否还有其他因素(如 morph target 偏差、maxFreq 跳变)。

#### 建议验证方向(非硬性,看代码能确认的不必复现)

- [ ] **太空丑**:在不同 orbitLevelCap(1/2/3)下截图对比,确认是否真的是 LOD 粗糙导致;测试独立 impostor 是否能解决
- [ ] **山脊锯齿**:加 debug 可视化(单独渲染 ridged 输出、可视化 GRAD 方向分布),验证是否是 simplex 方向性 bias;实验性扩展 GRAD 表看锯齿是否减少
- [ ] **地形散乱**:可视化 belt/mMask 掩码,确认是否是硬边界导致;实验性加 ecotone warp 看是否改善
- [ ] **几何边缘**:对比 LOD 接缝处与 chunk 内部的边缘,确认是 noise 还是 morph/skirt 问题
- [ ] 验证结果记录到本文档,更新推测根因

#### 优化方向(候选,根因验证后由执行者定方案)

**目标**:太空俯瞰与地表形态一致无方块感;LOD 切换不可见;山脊连续非锯齿;地形板块连贯无散乱硬边。

**约束**:噪声/height 算法改动破坏锁(走 re-curation);LOD 调度参数、轨道视图方案不破坏锁。

**可选思路**(执行者自由选择,不限于以下;根因验证后可能完全换方向):
- 噪声方向性 bias:fable5 的噪声烘焙思路(GRAD 扩展、多频段 ridged、domain warp)
- 地形省份边界软化:fable5 的 ecotone warp(指状交错而非等值线)
- LOD 粗糙度感知分裂:fable5 的 errBoost(粗糙区域提前分裂)
- 太空视图:独立轨道 impostor,避免 chunked LOD 在轨道距离采样不足
- 保留 `height(dir, maxFreq)` 单权威函数契约(AGENTS.md 要求),只在其上层加分类场

**参考项目**:fable5(算法可抄,WebGL2 重写)

#### 验收标准

- [ ] 太空俯瞰母星,地形形态与地表一致,无"方块感"
- [ ] LOD 切换不可见(morph 平滑)
- [ ] 山脊是连续线而非锯齿
- [ ] 母星地形板块连贯,无散乱硬边
- [ ] `npm test` 通过(锁重生成后)

---

### 2.2 光照与大气

#### 现状与推测根因(仅供参考,待验证)

- **光照不够细腻(推测)**:`src/galaxy.js:557` PointLight 强度 3.2 无衰减;`src/main.js:174` `sunShadow` DirectionalLight 颜色恒为 `0xffffff` 丢失色温;无 HDRI/环境贴图。推测这些是细腻度不足的原因,但需验证是否有其他因素(如 tonemap、exposure、材质粗糙度)。
- **日落不美(推测)**:`src/atmosphere-webgl.js` Rayleigh 颜色固定 `vec3(0.48,0.68,1.0)` 混 atmoColor(非物理波长);Mie 颜色恒定 `(1.0,0.93,0.82)` 不随太阳仰角变红;多次散射项太弱 `0.075*density*(1-h)` 晨昏过渡生硬;8-14 步长路径采样不足。这些都是推测,需实验验证哪个因素影响最大。
- **背阳面黑(推测)**:`src/main.js:2347` 夜间 ambient 仅 0.06,`hemi` 0.027;无星光、无天光反弹;大气壳 shader 的多次散射只照亮大气壳本身,不照亮地表。推测这是背阳面黑的原因,但需验证是否有间接光路径被忽略。
- **双星 sunDir 只取主星(事实)**:`src/galaxy.js:719-731` `sunDirFrom` 只取主星方向,伴星 PointLight 存在但不进大气 shader/地形 baked shadow/水面 fresnel。这是代码事实,但是否是用户感知问题的根因需验证。
- **大气比例 1:8**(真实 1:64),星球半径 286km(真实地球 1/22)——这是事实数据,但是否是"星球看小"的根因需验证(也可能是相机 FOV 或大气辉光视觉占比问题)。

#### 建议验证方向(非硬性,看代码能确认的不必复现)

- [ ] **光照细腻度**:对比有/无 HDRI、有/无色温传入的截图,确认细腻度差异来源
- [ ] **日落不美**:逐项隔离测试(只改 Rayleigh 波长 / 只改 Mie / 只加多次散射 / 只加步数),确认哪个改动影响最大
- [ ] **背阳面黑**:在背阳面加 debug 光源计数,确认实际光照贡献来源;验证 skylight 反弹是否真的缺失
- [ ] **星球看小**:对比不同半径(286km vs 700km)的太空视觉,确认是否真的是半径问题;检查相机 FOV 和大气辉光占比
- [ ] 验证结果记录到本文档,更新推测根因

#### 优化方向(候选,根因验证后由执行者定方案)

**目标**:光照细腻有层次;日落呈现红橙渐变;背阳面可见地表细节(非纯黑)有星光和天光;双星系统可见伴星的光照和散射贡献;近地太阳光保留恒星色温。

**约束**:shader/光照参数改动不破坏锁;星球半径放大破坏锁(走 re-curation)。

**可选思路**(执行者自由选择,不限于以下):
- 大气散射物理化:Rayleigh/Mie 改物理波长,日落红由长路径吸收自然产生(参考 wlBXWK)
- 多次散射:Hillaire 2020 多 octave 方案补满晨昏暗部(参考 HPVolumeCloud)
- 天光反弹:沿法线采样大气散射作为地表间接光,解决背阳面纯黑(参考 wlBXWK skylight)
- 星光 ambient:夜间微弱星光避免纯黑
- 大气壳与 skyDome 颜色同步:golden hour 反哺
- 双星 sunDir 数组化:shader 内对双星各自计算散射贡献
- 恒星色温传入 DirectionalLight
- 母星半径放大(目标 ~700-1000km),大气比例不收窄

**参考项目**:wlBXWK(大气散射)、HPVolumeCloud(多次散射)。**Íñigo Quílez 2013 不可抄**(许可证禁止)。

#### 验收标准

- [ ] 背阳面可见地表细节(非纯黑),有星光和天光
- [ ] 日落呈现红橙渐变,大气壳与 skyDome 颜色一致
- [ ] 双星系统可见伴星的镜面反射和大气散射贡献
- [ ] 近地太阳光保留恒星色温(非纯白)
- [ ] `npm test` 通过(锁重生成后)

---

### 2.3 水体与沙滩

#### 现状与推测根因(仅供参考,待验证)

- **平面感(事实)**:`src/planet.js:706` 水球壳顶点高度恒 0,`src/shaders-webgl.js:474-481` 只有法线扰动无顶点位移。
- **无真反射(事实)**:`src/shaders-webgl.js:470-472` 菲涅尔只是颜色 mix 到固定 `uSkyC`(构造时一次性固定,不随日落变化)。
- **无真折射(事实)**:看不到水底地形扭曲。
- **sunDirUniform 死代码(事实)**:`src/planet.js:893,903` 引用 `liquidMat.userData.sunDirUniform`,但全 src 无位置赋值,水材质完全不知道太阳方向。
- **沙滩固定线(推测)**:水面是 `seaRadius` 独立球壳,水线是固定半径圆;`src/planet.js:527` 陆地色板起点是干沙色从 seaLevel 直接开始,无湿润带、无泡沫、无浪花白边。推测这是沙滩怪的根因,但需验证是否还有 waterLod 与地形 LOD 不同步的贡献。
- **无飞船交互(事实)**:全 src 无 wake/splash/ripple 水交互。
- **无海洋星球(事实)**:`TYPES.ocean` 存在但无"几乎全是水"或"波涛汹涌"子分类,`applyWaterWaves` 用同一套参数给所有 water 星球。
- **水+光+大气+云无联动(事实)**:`uSkyC` 与 skyDome 颜色脱节,水材质无云阴影。

#### 建议验证方向(非硬性,看代码能确认的不必复现)

- [ ] **沙滩怪**:可视化 waterLod 与地形 LOD 的几何重合度,确认是否是 waterLod 不同步导致;验证湿润带/泡沫缺失的视觉贡献占比
- [ ] **平面感**:确认顶点位移缺失是唯一根因,还是法线扰动质量也有问题
- [ ] 验证结果记录到本文档,更新推测根因

#### 优化方向(候选,根因验证后由执行者定方案)

**目标**:水面有真位移(非平面);反射天空/云/日落;水下可见折射海床扭曲;沙滩有湿润带+泡沫过渡(非固定线);飞船贴水飞有涟漪/船迹;海洋星球有波涛汹涌效果;水颜色随日落变红;水/光/大气/云联动。

**约束**:全部为 shader/渲染改动,不破坏锁(若新增 TYPES 非字段常量也不调 rand())。球壳 FFT 性能敏感,只在玩家当前进入的星球启用。

**可选思路**(执行者自由选择,不限于以下):
- 顶点位移:FFT cascade 或 Gerstner 波轻量替代;球壳适配需切空间坐标
- 真反射:CubeCamera 周期性更新环境
- 真折射+焦散:复用已有 bakeDepth 做 Beer-Lambert 衰减
- 泡沫+湿润沙滩:雅可比行列式+浪峰+地形湿润暗化
- 飞船-水交互:2D 波动方程 ping-pong 纹理
- 海洋星球预设:各类型星球定义波涛参数(非 RNG 常量)
- sunDir 联动:接通现有死代码,水材质响应太阳方向
- 水+光+大气+云联动:uSkyC 运行时更新,水材质加云阴影

**参考项目**:realistic-threejs-ocean-simulation(用户自己,MIT,全套)、FFT-Ocean-Code(Gerstner/岸线)、HPWater(飞船水交互)

#### 验收标准

- [ ] 水面有真位移(非平面),近看有波浪起伏
- [ ] 水面反射天空/云/日落颜色(非固定色)
- [ ] 水下可见折射的海床扭曲
- [ ] 沙滩有湿润带 + 泡沫过渡(非固定线)
- [ ] 飞船贴水飞有涟漪/船迹
- [ ] 海洋星球有波涛汹涌效果
- [ ] 水颜色随日落变红
- [ ] `npm test` 通过(锁重生成后,如涉及 TYPES 改动)

---

### 2.4 植被与材质

#### 现状与推测根因(仅供参考,待验证)

- **草像稀疏杂草(事实+用户判断)**:现有草几何是"恶劣环境杂草"形态(沙漠/浅雪风格),且密度偏低(约 0.038 簇/m²),**种类和密度都不对**,综合呈现"稀疏杂草"感。需要同时解决:种类(做成真正草地的草)+ 密度(草地区要连片成草坪)。
- **树低模(事实)**:`src/flora.js:127-183` `buildTree` 150-400 三角形,无 LOD,和发光植物(`buildPodPlant` 0.55 自发光)质量差距大。
- **无岩石材质(事实)**:`src/shaders-webgl.js:330` 只有"陡坡时把底色 lerp 成 `uRockC` 单色",无独立法线/粗糙度/纹理。岩石模型只存在于 scatter(`src/scatter.js:67` `craggyGeo`)。
- **雪线固定海拔(事实)**:`src/shaders-webgl.js:367-375` per-fragment 但只按海拔 + 纬度,无温度、无坡度(粗坡度)、无北坡、无凹腔积雪。
- **沙滩衔接差**:见 2.3。

#### 建议验证方向(非硬性,看代码能确认的不必复现)

- [ ] **草种类+密度**:确认现有草几何(恶劣环境杂草形态)和新草类型的必要性;同时验证密度提升对"连片草坪"感的贡献,两者需同时解决
- [ ] **树质量差距**:确认是几何精度问题还是材质/光照问题(ez-tree 是否真的能解决)
- [ ] **雪线**:验证固定海拔雪线是否真的是用户痛点(可能用户更在意的是"横线划分"的视觉感,而非温度模型)
- [ ] 验证结果记录到本文档,更新推测根因

#### 优化方向(候选,根因验证后由执行者定方案)

**目标**:树有多级 LOD,近看质量提升,与发光植物协调;草地区连片成草坪(新草类型+高密度),恶劣环境保留稀疏杂草;岩石有层理/裂理/凹腔质感非单色;雪线随温度/坡度/北坡变化,雪边有锯齿状有机边界。

**约束**:全部不破坏锁(植被 namespace 独立,shader 改动不改 colorAt 的 rand())。

**可选思路**(执行者自由选择,不限于以下):
- 树:ez-tree 骨架生长 + 多级 LOD(MIT 可直接抄代码)
- 草地草:billboard clump on quads + InstancedMesh + Chunking + LOD,避免 individual blades;保留现有杂草作为恶劣环境草;clump field 控制草丛分布
- 岩石:程序化 SDF 生成层理/裂理/凹腔几何 + 材质质感(参考 fable5 RockBuilder 算法,WebGL2 重写)
- 雪线:温度模型(纬度+海拔+北坡)+ 坡度+凹腔积雪,hash-dithered 有机边界(参考 fable5 BiomeSnow);cube-sphere 适配需顶点预计算 varying
- 岩石材质:fragment 加独立法线/粗糙度

**参考项目**:ez-tree(MIT,直接抄)、fable5(岩石 SDF/雪线/clump 算法可抄 WebGL2 重写)、"How to Make The Fluffiest Grass"(billboard clump)

#### 验收标准

- [ ] 树有 3 级 LOD,近看质量明显提升,与发光植物质量协调
- [ ] 草地草密集(视觉上连片草坪),恶劣环境草稀疏(保留现有)
- [ ] 岩石有层理/裂理/凹腔质感,非单色 tint
- [ ] 雪线随温度/坡度/北坡变化,非固定海拔横线
- [ ] 雪边有锯齿状有机边界(非渐变带)
- [ ] `npm test` 通过(植被改动不破坏锁)

---

### 2.5 星系与宇宙

#### 现状与推测根因(仅供参考,待验证)

**代码事实(已确认)**
- 双星率实测 31-33%(neighborhoodProfile.binaries=20/64),与真实银河系 ~1/3 一致。
- `src/galaxy-layout.js:64-68` bulge 区域 `Math.pow(rand(), 1.7) * GALAXY_RADIUS_CELLS * 0.18`,理论上可产出距原点 <1 cell(<40 亿米)的 bulge 系统,与 authored 黑洞(固定 [0,0,0])共享原点。
- `src/astronomy.js:414-416` `160000 + bodyRand()*240000`,母星 286km(真实地球 1/22)。
- `src/planet.js:110` `atmoFraction=0.09-0.135`,比例 1:8(真实 1:64)。

**推测(仅供参考,待验证)**
- **双星过多印象的根因推测**:用户感觉"双星过多",推测源于母星本身是双星 + 18 邻居 1/3 双星 + 星图视觉偏差(双星在星图上可能更显眼)。但这是推测,实际印象根因需验证(可能是单个邻居双星的特殊视觉效果、星图标注方式、或非双星的其他因素)。
- **黑洞周围恒星过近的合理性推测**:理论上 bulge 区域公式可产出贴脸黑洞的系统,推测这是用户感觉"不合理"的根因。但实际 neighbourhoodProfile 中是否真有贴脸系统、视觉效果是否真的不合理,需在游戏中实际验证。
- **星球半径偏小是否是"看小"根因的推测**:半径 286km 确实小于地球,但用户感觉"星球看小"的根因可能是半径,也可能是相机 FOV、大气辉光视觉占比、下降速度感知等因素,需验证。

#### 建议验证方向(非硬性,看代码能确认的不必复现)

- [ ] **双星过多印象**:实际游玩/截图 18 邻居,确认双星视觉占比和印象来源;验证是否单个双星邻居的特殊轨道/光照造成的印象,而非"数量多"
- [ ] **黑洞周围恒星过近**:在 neighbourhoodProfile 中查实际距离分布;实地飞到黑洞附近截图,验证"贴脸"是否真的视觉不合理
- [ ] **星球看小**:对比不同半径(286km vs 700km)的太空视觉;同时检查相机 FOV、大气辉光占比是否是次要因素
- [ ] 验证结果记录到本文档,更新推测根因

#### 优化方向(候选,根因验证后由执行者定方案)

**目标**:母星是单星系统;黑洞周围无 bulge 系统贴脸;母星半径放大到 ~700-1000km 太空看更真实;下降时间无明显增加。

**约束**:母星单星、黑洞最小距离、半径放大都破坏锁(走 re-curation);下降速度补偿不破坏锁。

**可选思路**(执行者自由选择,不限于以下):
- 母星单星:binaryChance 对 isHome 分支归零,其他系统保留真实 1/3 双星率
- 黑洞周围最小距离:bulge 区域半径公式加最小半径约束
- 半径放大:radius 公式提升母星半径,atmoFraction 保持不变(接受与真实比例偏差)
- 下降时间补偿:测试并调整下降速度公式,确保放大半径后下降体验不变

**注意**:radius 与内容身份绑死(进锁字段 + 决定 hAmp/sentinel + 影响 rocheRadius/ringSystem),必须 re-curation。

#### 验收标准

- [ ] 母星是单星系统
- [ ] 黑洞周围无 bulge 系统贴脸(<2 cells)
- [ ] 母星半径 ~700-1000km,太空看更真实
- [ ] 从轨道到地表下降时间无明显增加(<90s)
- [ ] `npm test` 通过(锁重生成后)

---

### 2.6 星环

#### 现状与推测根因(仅供参考,待验证)

**代码事实(已确认)**
- `src/planet.js:867-869` `RingGeometry(inner, outer, 160, 1)`——1 环向分段无厚度。
- `src/planet.js:877-881` `MeshBasicMaterial` 不响应光照,无日夜分界,无环阴影。
- `src/planet.js:1208-1228` `makeRingTexture` 256×1 像素 canvas,每 8 像素一个 `rand()*rand()` 脉动,无 Cassini Division 等真实环结构。
- 无环投影到行星、无行星投影到环。

**推测(仅供参考,待验证)**
- **星环"太假"的根因推测**:推测根因是上述全部缺陷叠加(无光照、无厚度、低分辨率贴图、无真实环结构)。但用户感觉"太假"的主因需验证——可能是其中某一项最关键(如无光照响应),也可能是几何分段不足导致的"硬圆盘"感最强。

#### 建议验证方向(非硬性,看代码能确认的不必复现)

- [ ] **太假主因**:逐项隔离测试(只加光照 / 只换高分辨率贴图 / 只加厚度),确认哪一项改动对"真实感"贡献最大
- [ ] **几何分段**:测试 1 环向分段 vs 增加分段,确认是否是"硬圆盘"感的主因
- [ ] 验证结果记录到本文档,更新推测根因

#### 优化方向(候选,根因验证后由执行者定方案)

**目标**:环有光照响应(日夜分界、阴影中变暗);有 Cassini Division 等真实环结构;行星表面有环带阴影;环被行星挡住的部分变暗;alpha 分层(实心环段+稀薄环段对比)。

**约束**:不破坏锁(前提:不增删 rand() 调用,只改材质端)。

**可选思路**(执行者自由选择,不限于以下):
- 材质 shader 化:MeshBasicMaterial 换 ShaderMaterial(可参考 sysview 的 ringMaterial 思路)
- 程序化 bands/gap/edge:Cassini Division、Encke Gap 等共振密度波
- 光照:环在行星阴影中变暗,日夜分界
- 双向投影:环投影到行星 + 行星投影到环

**参考项目**:sysview 的 ringMaterial shader 思路

#### 验收标准

- [ ] 环有光照响应(日夜分界、阴影中变暗)
- [ ] 环有 Cassini Division 等真实环结构
- [ ] 行星表面有环带阴影
- [ ] 环被行星挡住的部分变暗
- [ ] `npm test` 通过(不破坏锁)

---

### 2.7 音效

#### 现状与推测根因(仅供参考,待验证)

**代码事实(已确认)**
- `src/audio.js:72-78` 主引擎锯齿波 42Hz,增益 0.16。
- `src/audio.js:80-86` 次低音三角波 21Hz,增益 0.4(是主引擎 2.5 倍)。
- `src/audio.js:66-70` `engineFilter` 低通 520Hz 静止 / 2140Hz 飞行。
- 无 PannerNode、无 ConvolverNode、无立体声分离 → 单声道直达。
- `compressor` ratio 5:1。
- 完全缺失:环境音(风/海浪/鸟鸣)、UI 音、脚步声、飞船系统音。

**推测(仅供参考,待验证)**
- **"嗡嗡嗡像劣质飞机"的根因推测**:推测是多个因素叠加——21Hz 三角波增益过高 dominates 整个引擎声、低通滤波砍掉高频空气感、单声道直达无空间感、compressor 压平动态。但**实际听感根因需 A/B 实验验证**,可能是其中某一项(如 21Hz 三角波)是主因,其他是次要。**严禁仅凭推测就重写整个引擎音合成器**——需先逐项隔离测试。

#### 建议验证方向(非硬性,看代码能确认的不必复现)

- [ ] **嗡嗡主因**:逐项隔离测试(只降 21Hz 增益 / 只改滤波截止频率 / 只加 PannerNode / 只降 compressor ratio),用 A/B 听感对比确认哪一项改动对"嗡嗡消失"贡献最大
- [ ] **劣质飞机感**:确认是否是滤波截止频率 2140Hz 砍掉高频导致的"闷感",还是锯齿波本身的"粗糙感"
- [ ] 验证结果记录到本文档,更新推测根因

#### 优化方向(候选,根因验证后由执行者定方案)

**目标**:引擎音不再"嗡嗡嗡",有飞船感和空间感;walk 模式有环境音(风/海浪/生物);UI 操作有反馈音;飞船系统事件有音效。

**约束**:全部不破坏锁(audio namespace 独立)。

**可选思路**(执行者自由选择,不限于以下;具体合成器架构由执行者根据 A/B 听感验证结果决定):
- 引擎音:多层振荡器组合、LFO 调制呼吸感、多段频谱滤波保留高频空气感、HRTF Panner 空间感、降低次低音增益、降低 compressor ratio 保留动态
- 环境音:walk 模式风声(按风速/biome)、海浪声(近水)、鸟鸣/虫鸣(按 biome+昼夜)、雨声(配合天气)
- UI 音:菜单点击、HUD 滚动、指针悬停、扫描完成、锁定提示
- 飞船系统音:警告、锁定、扫描、充能、爆炸、命中反馈

**参考**:现有 `src/audio.js` 合成器结构、`assets/audio/` 21 个 MP3 背景音乐

#### 验收标准

- [ ] 引擎音不再"嗡嗡嗡",有飞船感和空间感
- [ ] walk 模式有环境音(风/海浪/生物)
- [ ] UI 操作有反馈音
- [ ] 飞船系统事件有音效
- [ ] `npm test` 通过(音效不破坏锁)

---

### 2.8 天气系统(新增)

#### 现状与推测根因(仅供参考,待验证)

**代码事实(已确认)**
- 有大气但无天气系统。
- 云是体积云,coverage 静态。

**推测(仅供参考,待验证)**
- **云静态感的根因推测**:推测是 `clouds.js`/`clouds-webgl.js` 没有 wind field uniform,shader 采样 UV 不随时间偏移。但实际静态感是否真源于此,需查 shader 确认是否已有 time-based offset 被注释或弱化。

#### 建议验证方向(非硬性,看代码能确认的不必复现)

- [ ] **云静态感**:阅读 `src/clouds.js` 和 `src/clouds-webgl.js`,确认是否真的无 wind uniform;如有但弱,确认弱的原因
- [ ] **天气系统缺失**:确认用户对"天气系统"的具体期望(是动态云流动 / 雨雪 / 风 / 雷暴?),避免实施方向偏差
- [ ] 验证结果记录到本文档,更新推测根因

#### 优化方向(候选,根因验证后由执行者定方案)

**目标**:云层随时间流动变化;不同区域有不同云类型(积云/层积云/高空云);地表有体积雾/光柱效果;植被有层级风运动(非统一摇摆)。

**约束**:全部不破坏锁。

**可选思路**(执行者自由选择,不限于以下):
- 云动态流动:wind field uniform 驱动采样 UV 偏移,detail 噪声比 base 噪声更快(参考 HPVolumeCloud 风场)
- 天气图双通道:Lo(coverage/cloudType/scMask)+ Hi(hiMask/asAc/msWeight)驱动密度和高度拉伸(参考 HPVolumeCloud 天气图)
- 体积雾/光柱:WebGL2 兼容的 froxel 或在现有体积 pass 上加 ground-hug fog + sun shaft;湿度场驱动雾密度(配合 2.1 新增 moisture 字段)
- 层级风 5 级运动:mean lean + sway + branch secondary + leaf flutter + grass bend(参考 fable5 Wind);**关键原则**:阵风只调 amplitude 绝不调 frequency

**参考项目**:HPVolumeCloud(风场/天气图/多次散射)、fable5(Froxel 体积雾/层级风,算法可抄 WebGL2 重写)

#### 验收标准

- [ ] 云层随时间流动变化
- [ ] 不同区域有不同云类型(积云/层积云/高空云)
- [ ] 地表有体积雾/光柱效果
- [ ] 植被有层级风运动(非统一摇摆)
- [ ] `npm test` 通过(天气不破坏锁)

---

## 三、参考项目索引

### 3.1 海洋水体参考

路径:`D:\Eray0\Documents\_GitRES\Game\建议参考的优质项目\海洋水体效果参考\`

| 项目 | 引擎 | 许可证 | 抄到深空哪个子系统 |
|---|---|---|---|
| `realistic-threejs-ocean-simulation` | Three.js + WebGL2 | MIT(用户自己) | 2.3 水体(FFT/反射/折射/焦散/泡沫/SSS) |
| `FFT-Ocean-Code-main` | Unity HLSL | MIT | 2.3 水体(Gerstner 波轻量替代、屏幕空间岸线) |
| `HPWater-main` | Unity HDRP | MIT | 2.3 水体(飞船-水交互 2D 波动方程) |

### 3.2 地面风景参考

路径:`D:\Eray0\Documents\_GitRES\Game\建议参考的优质项目\地面风景参考\`

| 项目 | 引擎 | 许可证 | 抄到深空哪个子系统 |
|---|---|---|---|
| `fable5-world-demo-main` | **WebGPU + TSL + Compute** | MIT | 2.1 地形(errBoost/ecotone warp)、2.4 植被(岩石 SDF/雪线/clump)、2.8 天气(Froxel/层级风)。**算法可抄,代码用 WebGL2 重写** |
| `ez-tree-main` | 纯 WebGL + Three.js | MIT | 2.4 植被(3 级 LOD 树)。**可直接抄代码** |

### 3.3 大气体积云参考

路径:`D:\Eray0\Documents\_GitRES\Game\建议参考的优质项目\大气与体积云参考\`

| 项目 | 许可证 | 抄到深空哪个子系统 |
|---|---|---|
| `HPVolumeCloud-main` | MIT(2026 AshenOneArt) | 2.2 大气(Hillaire 多次散射)、2.8 天气(风场/天气图) |
| `MIT - 体积云和行星大气散射效果.txt`(ShaderToy wlBXWK) | MIT(2019 Dimas Leenman) | 2.2 大气(物理波长 Rayleigh/skylight/exposure tonemap) |
| `MIT - atmosphere.txt`(tellux) | MIT | 仅思路参考(API 用法) |
| `Íñigo Quílez 2013 体积云着色器.txt` | **禁止商用/非商用/分发/AI训练** | **不可抄**,只能阅读学习 |

### 3.4 许可证合规

- 三个 MIT 项目抄时在 `THIRD_PARTY_NOTICES.md` 加 attribution:
  - "Atmospheric scattering: based on `Atmospheric scattering explained` by Dimas Leenman (MIT, 2019), see https://www.shadertoy.com/view/wlBXWK"
  - "Volumetric cloud lighting (Hillaire MS, phi_fwd): based on HanPi Volume Cloud System by AshenOneArt (MIT, 2026)"
  - "Water rendering: adapted from realistic-threejs-ocean-simulation (MIT, Eray114514), FFT-Ocean-Code (MIT, ChenHANMK1), HPWater (MIT, AshenOneArt)"
  - "Tree generation: based on ez-tree by Daniel Greenheck (MIT, 2024)"
  - "Terrain algorithms: inspired by fable5-world-demo by Remi Sebastian Kits (MIT, 2026)"
- **IQ 2013 绝对不能抄**:代码、变量名、算法结构都不能出现在深空里
- 算法本身不受版权保护,MIT 主要管代码文本

### 3.5 痛点-参考项目映射(只指方向,不指定具体文件)

> 注意:下表只标注痛点对应哪个参考项目和子系统方向,**具体落地到哪个文件由执行者在根因验证后自行决定**。

| 深空痛点 | 参考项目 | 可借鉴思路 | 子系统 |
|---|---|---|---|
| 地形 LOD 切换、太空丑 | fable5 | errBoost LOD | 2.1 地形 |
| 山脊锯齿 | fable5 | 噪声烘焙(GRAD/ridged3/warp) | 2.1 地形 |
| 地形散乱 | fable5 | ecotone warp | 2.1 地形 |
| 背阳面黑 | wlBXWK | skylight、ambient | 2.2 光照 |
| 日落不美 | wlBXWK | 物理波长 Rayleigh、exposure | 2.2 光照 |
| 多次散射弱 | HPVolumeCloud | Hillaire 多 octave | 2.2 光照 / 2.8 天气 |
| 水平面 | realistic-threejs-ocean | FFT 顶点位移 | 2.3 水体 |
| 水无反射 | realistic-threejs-ocean | CubeCamera | 2.3 水体 |
| 水无折射 | realistic-threejs-ocean | refract + depth | 2.3 水体 |
| 沙滩固定线 | fable5 + FFT-Ocean | wet darkening + foam | 2.3 水体 |
| 飞船-水交互 | HPWater | 2D 波动方程 | 2.3 水体 |
| 海洋星球 | realistic-threejs-ocean | 预设参数集 | 2.3 水体 |
| 树低模 | ez-tree | 多级 LOD 树 | 2.4 植被 |
| 草像稀疏杂草 | "Fluffiest Grass" | billboard clump | 2.4 植被 |
| 无岩石材质 | fable5 | SDF strata+cut+cavity | 2.4 植被 |
| 雪线固定海拔 | fable5 | temp+北坡+laplacian | 2.4 植被 |
| 云静态 | HPVolumeCloud | 风场 | 2.8 天气 |
| 无天气系统 | HPVolumeCloud | 天气图双通道 | 2.8 天气 |
| 星环太假 | sysview | shader 化 | 2.6 星环 |

---

## 四、re-curation 流程

### 4.1 触发条件

本次全面优化中,以下改动破坏锁,需在所有子系统优化完成后一次性 re-curation:
- noise.js 改造(GRAD 扩展、ridged3、domain warp)
- planet.js height() 改造(ecotone warp、belt 边界软化、moisture 字段)
- 母星单星(astronomy.js binaryChance isHome 分支)
- 黑洞周围最小距离(galaxy-layout.js bulge regionPosition)
- 星球半径放大(astronomy.js radius 公式)
- TYPES.relief 调整(配合半径放大)

### 4.2 完整步骤

参考 `package.json:28-30` 三个脚本:

1. **候选生成与打分**:`npm run world:curate`
   - `tools/curate-finite-galaxies.js` 枚举 MILKY-001 到 MILKY-256,对每个 seed 调用 `buildGalaxyCatalog` + `generateSystemSpec` + `buildCivilizationSites`,计算 `visualScore`
   - 输出 `worlds/finite-candidates.json`,列出 top12 / top4
   - 成本:纯 Node 计算 256 个 seed,几十秒到几分钟

2. **截图人工评审**:`SEEDS=MILKY-038,... npm run world:curate:shots`
   - `tools/capture-world-candidates.js` 启动本地 server + Playwright,对每个 seed 截图 spawn、各类型行星轨道、低空飞行、地表、飞船
   - 输出到 `test-results/world-candidates/{seed}/`
   - 成本:每 seed ~1-2 分钟浏览器时间

3. **更新 `src/world-config.js`**:把 `WORLD_CONFIG.galaxies['milky-way'].seed` 改成选中的 seed

4. **生成新锁**:`npm run world:lock`
   - `tools/export-galaxy-catalog.js` 写 `worlds/milky-way.catalog.json`
   - `tools/export-canonical-world.js` 调 `buildCanonicalWorldLock()` 写 `worlds/milky-way.lock.json`

5. **验证**:
   - `npm test`(纯 Node 合约检查,~3s)
   - `npm run test:smoke`(一次浏览器启动,~1min)
   - `npm run test:full`(全套浏览器套件)
   - 视觉验证:`docs/curation/finite-worlds-v2/{seed}/` 固定相机捕获
   - multiplayer/save 迁移评审(AGENTS.md 要求)

### 4.3 验证点(AGENTS.md "Canonical Universe Contract")

- 静态 curation 评审(候选打分)
- 固定相机捕获(orbit / low-flight / surface 三视图)
- 浏览器 playtest
- multiplayer/save 迁移评审
- 在 lock 中记录 compat break(注释/commit message)

### 4.4 不能做的

- 不能"为了通过测试"而 `npm run world:lock`(`tools/worldlocktest.js:21-22` 错误信息明确禁止)
- 不能 hand-edit `dist/`
- 不能用另一个有限 baked universe 替换 MILKY-038
- 不能把 save file 当世界内容

---

## 五、决策记录

| 决策点 | 用户选择 | 理由 |
|---|---|---|
| 双星率 | 只改母星,母星要单星 | 实测 31-33% 与真实一致,但母星单星更友好 |
| 半径策略 | 放大但大气不收窄 | 接受与真实比例的偏差,优先太空看真实感 |
| 执行顺序 | 全面优化不分波次 | 既然锁一定重做,放开手优化效果更好 |
| 树策略 | 直接集成 ez-tree | MIT 可直接抄代码,3 级 LOD 质量提升大 |
| 草策略 | 新增草地草类型 + 提升密度 | 现有草是恶劣环境杂草且稀疏,需新做草地草并提升密度成连片草坪 |

---

## 六、风险与注意事项

1. **WebGPU → WebGL2 落差**:fable5 大量依赖 compute shader、StorageTexture、StorageBuffer、atomicAdd,WebGL2 都没有。算法层借鉴,代码层重写。最痛的是 Scatter 的 atomic append——WebGL2 必须改成 CPU 端 JS 散布(深空 scatter.js 已是这个模式)。

2. **cube-sphere 适配**:fable5 的 2D world xz → uv 纹理采样在球面上不工作。深空必须用顶点预计算 varying 或 render-to-texture 球面投影。FFT 水面需切空间坐标适配。

3. **height() 单函数约束**:深空 AGENTS.md 强调 `height(dir, maxFreq)` 是单权威函数,各级 LOD 共享。**不要**改成 heightfield 纹理架构,保持 height() 函数,只在其上层加分类场(顶点预计算)。

4. **球壳 FFT 性能**:只在玩家当前进入的星球启用 FFT,其他用静态法线扰动。多个星球同时跑 FFT 不可行(1024 星系)。

5. **草密度性能**:InstancedMesh draw call 不变,但 instance 上传带宽是瓶颈。用 DynamicDrawUsage + staging buffer 增量更新;LOD 远距不画草;chunking + frustum culling。

6. **IQ 2013 许可证**:绝对不能抄,代码、变量名、算法结构都不能出现在深空里。

7. **re-curation 时机**:所有破坏锁的改动完成后一次性 re-curation,不要中途多次 re-curation(每次都要重新筛选+评审+验证,成本高)。

8. **测试纪律**:每次子系统改动后 `npm test`(~3s);大改后 `npm run test:smoke`(~1min);PR/发布前 `npm run test:full` + 针对性 browser test;视觉改动 `npm run shots` 截图对比。

---

## 七、文档维护

- 本文档随优化进度更新,每完成一个子系统在对应章节标注完成日期和 commit hash
- re-curation 完成后记录新 seed 和 lock 指纹
