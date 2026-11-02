const banned = /索引|桥接|适配扩展|进程树|revision|协议版本|快照|撤回|写盘|写入不完整/;
const chinese = /[\u3400-\u9fff]/;
export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      terminology: '用户提示请使用术语表中的常用说法：{{word}}。',
      raw: '用户提示不能直接插入原始异常，请用 readableError 或具体的中文提示。',
      retry: '请先写明原因，再告诉用户重试。',
    },
  },
  create(context) {
    const source = context.sourceCode;
    const diagnostic = (node) => {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent.type !== 'CallExpression') continue;
        if (/(?:^|\.)diagnostic$|^console\./.test(source.getText(parent.callee))) return true;
      }
      return false;
    };
    const check = (node, value) => {
      if (!chinese.test(value) || diagnostic(node)) return;
      const match = banned.exec(value);
      if (match) context.report({ node, messageId: 'terminology', data: { word: match[0] } });
      if (/^\s*请(?:稍后)?重试[。！!]?\s*$/.test(value)) context.report({ node, messageId: 'retry' });
    };
    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      JSXText(node) {
        check(node, node.value);
      },
      TemplateLiteral(node) {
        const text = node.quasis.map((part) => part.value.cooked ?? '').join('');
        check(node, text);
        if (
          chinese.test(text) &&
          !diagnostic(node) &&
          node.expressions.some((expression) =>
            /errorText\s*\(|\.message\b|String\(error\)/.test(source.getText(expression)),
          )
        )
          context.report({ node, messageId: 'raw' });
      },
    };
  },
};
