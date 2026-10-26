-- Verified from the 20 public BJTU computer-science article URLs on 2026-10-26.
-- Only replace the matching legacy column title. Keep original SQL, IDs, bodies,
-- timestamps, labels, source policy and personal records unchanged.
WITH verified_titles(id, url, old_title, article_title) AS (VALUES
  ('1233ab626acb88ba001caa471772eda6', 'https://cs.bjtu.edu.cn/zsjy/yjszs3/yjszs_sszs/977daa9ab8e240dbb1af6ea5b3b41ee1.htm', '研究生招生', '2027年候补推免考生位次更新情况。'),
  ('1233ab626acb88ba001caa495fa1dff3', 'https://cs.bjtu.edu.cn/zsjy/yjszs3/yjszs_sszs/d6fc39edc9374eaaa3f16c00c0821f51.htm', '研究生招生', '北京交通大学计算机科学与技术学院、国家卓越工程师学院（计算机技术专业）预推免复试考核结果20260920'),
  ('1233ab626acb88bd001caa4b5b896c3b', 'https://cs.bjtu.edu.cn/bkstd/bkstz/abda03d971c64213909f7a178f543d83.htm', '本科生教育', '计算机科学与技术学院推荐2027届优秀应届本科毕业生免试攻读研究生（普通类别）名单公示'),
  ('1233ab626acb88c0001caa5002e72f7d', 'https://cs.bjtu.edu.cn/zsjy/yjszs3/yjszs_sszs/8ce8fda50ff4483fbac2176c12a33b2b.htm', '研究生招生', '计算机科学与技术学院2027年接收推荐免试硕士研究生（含直博生）预报名的通知'),
  ('1233ab626acd73e6001f4d5833455f53', 'https://cs.bjtu.edu.cn/zsjy/yjszs3/yjszs_sszs/6dae5b7a496a4c1c935e519f2fb188d7.htm', '研究生招生', '北京交通大学计算机科学与技术学院2026年全国优秀大学生暑期夏令营入营通知已经通过报名系统发放'),
  ('1233ab626acd73ec001f4d6736ee6ff0', 'https://cs.bjtu.edu.cn/zsjy/yjszs3/yjszs_sszs/28bef730474649b090ea9e4c622a9583.htm', '研究生招生', '2026年计算机学院夏令营报名常见问题解答'),
  ('1233ab626acd73ee001f4d6a6f53a4db', 'https://cs.bjtu.edu.cn/yjstd/yjstz/0d06f9f4012849b29af4ba796c060592.htm', '研究生教育', '关于2026年夏季学期研究生课程开课及选课相关事宜的通知'),
  ('15ff78a66acb88bb000bcde62a22b69d', 'https://cs.bjtu.edu.cn/zsjy/yjszs3/yjszs_sszs/798364256a96493196e421895380532a.htm', '研究生招生', '北京交通大学计算机科学与技术学院2027年推免生机试日程安排'),
  ('15ff78a66acb88bd000bcdea67f22f2d', 'https://cs.bjtu.edu.cn/zsjy/yjszs3/yjszs_sszs/e468bfa6543445ea8f873e9833030b1e.htm', '研究生招生', '北京交通大学计算机科学与技术学院2027年预推免复试通知已通过我校推免预报名系统发放'),
  ('15ff78a66acb88bf000bcdef63f70773', 'https://cs.bjtu.edu.cn/zsjy/yjszs3/yjszs_sszs/20ecc413aa854846aaa12f4e682ab62d.htm', '研究生招生', '计算机科学与技术学院2027年接收推荐免试直博生面试安排'),
  ('15ff78a66acd73e4000e62f210e55c3c', 'https://cs.bjtu.edu.cn/bkstd/bkstz/74e7f9ee649847acb3ec66543eada977.htm', '本科生教育', '关于做好2025-2026学年春季学期课程补考工作的通知'),
  ('15ff78a66acd73e7000e62f63dad1a34', 'https://cs.bjtu.edu.cn/zsjy/yjszs3/yjszs_sszs/a89f871d970b4b11bca26aafc28fae50.htm', '研究生招生', '2026级硕士与博士研究生新生档案寄达查询'),
  ('15ff78a66acd73e8000e62f73cd331d6', 'https://cs.bjtu.edu.cn/zsjy/yjszs3/yjszs_sszs/045bf4456d594c4d99678233d9a16e8a.htm', '研究生招生', '北京交通大学计算机科学与技术学院2026年全国优秀大学生暑期夏令营日程表'),
  ('15ff78a66acd73ed000e63016d357056', 'https://cs.bjtu.edu.cn/zsjy/yjszs3/yjszs_sszs/4127a25aa35c4c928aeefb0c0fc48edc.htm', '研究生招生', '关于2026级硕士研究生录取通知书发放的通知'),
  ('bda3c2dc6acd73e10014a5390ea08cd5', 'https://cs.bjtu.edu.cn/bkstd/bkstz/00b22e6f3a214da1830a9157c466370f.htm', '本科生教育', '计算机科学与技术学院推荐2027届优秀应届本科毕业生免试攻读研究生工作实施细则'),
  ('bda3c2dc6acd73e20014a53e17c4e880', 'https://cs.bjtu.edu.cn/bkstd/bkstz/81a2058107a04e8993053a3eaa00b8cd.htm', '本科生教育', '关于推荐2027届优秀应届本科毕业生免试攻读研究生工作办法的通知'),
  ('bda3c2dc6acd73e30014a5450077ab48', 'https://cs.bjtu.edu.cn/bkstd/bkstz/efeecd8aa9d14a20b1ea45bff1867f1a.htm', '本科生教育', '关于2026-2027学年第一学期本科生报到注册工作的通知'),
  ('bda3c2dc6acd73e50014a55569e0d573', 'https://cs.bjtu.edu.cn/zsjy/yjszs3/yjszs_sszs/d159499dd1de40949b198519c8ae905d.htm', '研究生招生', '关于暴雨橙色预警期间调整我院2026年暑期夏令营7月10日活动安排的通知'),
  ('e04862b86acb88be0009ba4e5da208aa', 'https://cs.bjtu.edu.cn/tzgg/5430656e07e2464d8802c751f731645a.htm', '通知公告', '计算机科学与技术学院关于2027届推免学生科研创新素养模块认定公开答辩的补充通知'),
  ('e04862b86acd73ef000b1a4e42b9594b', 'https://cs.bjtu.edu.cn/zsjy/yjszs3/yjszs_sszs/43d0504187d64309b1a97154f22a7e1d.htm', '研究生招生', '北京交通大学计算机科学与技术学院2026年全国优秀大学生暑期夏令营通知')
)
UPDATE campus_documents AS d
SET body = jsonb_set(d.body, '{title}', to_jsonb(v.article_title), true)
FROM verified_titles AS v
WHERE d.collection = 'items' AND d.id = v.id
  AND d.body->>'originalUrl' = v.url
  AND d.body->>'title' = v.old_title
  AND d.body->>'sourceId' = '15ff78a66acb889d000bcdb945e4c113'
  AND coalesce(d.body->>'ownerOpenid', '') = ''
  AND coalesce(d.body->>'scope', '') <> 'private';
