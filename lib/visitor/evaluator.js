
/*!
 * CSS - Evaluator
 * Copyright(c) 2010 LearnBoost <dev@learnboost.com>
 * MIT Licensed
 */

/**
 * Module dependencies.
 */

var Visitor = require('./')
  , nodes = require('../nodes')
  , Stack = require('../stack')
  , Frame = require('../stack/frame')
  , Scope = require('../stack/scope')
  , utils = require('../utils')
  , bifs = require('../functions')
  , dirname = require('path').dirname
  , fs = require('fs');

/**
 * Initialize a new `Evaluator` with the given `root` Node
 * and the following `options`.
 *
 * Options:
 *
 *   - `compress`  Compress the css output, defaults to false
 *
 * @param {Node} root
 * @api public
 */

var Evaluator = module.exports = function Evaluator(root, options) {
  options = options || {};
  Visitor.call(this, root);
  this.stack = new Stack;
  this.functions = options.functions || {};
  this.paths = options.paths || [];
  this.paths.push(dirname(options.filename || '.'));
  this.stack.push(this.global = new Frame(root));
};

/**
 * Inherit from `Visitor.prototype`.
 */

Evaluator.prototype.__proto__ = Visitor.prototype;

/**
 * Proxy visit to expose node line numbers.
 *
 * @param {Node} node
 * @return {Node}
 * @api public
 */

var visit = Visitor.prototype.visit;
Evaluator.prototype.visit = function(node){
  try {
    this.lineno = node.lineno;
    return visit.call(this, node);
  } catch (err) {
    // TODO: less-lame hack to reference
    // the origin node source input
    err.str = err.str || node.source;
    throw err;
  }
};

/**
 * Evaluate the tree.
 *
 * @return {Node}
 * @api public
 */

Evaluator.prototype.evaluate = function(){
  return this.visit(this.root);
};

/**
 * Visit Root.
 */

Evaluator.prototype.visitRoot = function(block){
  for (var i = 0; i < block.nodes.length; ++i) {
    this.rootIndex = i;
    block.nodes[i] = this.visit(block.nodes[i]);
  }
  return block;
};

/**
 * Visit Block.
 */

Evaluator.prototype.visitBlock = function(block){
  this.stack.push(new Frame(block));
  for (var i = 0, len = block.nodes.length; i < len; ++i) {
    block.nodes[i] = this.visit(block.nodes[i]);
  }
  this.stack.pop();
  return block;
};

/**
 * Visit Color.
 */

Evaluator.prototype.visitColor = function(color){
  return color;
};

/**
 * Visit HSLA.
 */

Evaluator.prototype.visitHSLA = function(hsla){
  return hsla;
};

/**
 * Visit Literal.
 */

Evaluator.prototype.visitLiteral = function(lit){
  return lit;
};

/**
 * Visit Boolean.
 */

Evaluator.prototype.visitBoolean = function(bool){
  return bool;
};

/**
 * Visit Unit.
 */

Evaluator.prototype.visitUnit = function(unit){
  return unit;
};

/**
 * Visit Ident.
 */

Evaluator.prototype.visitIdent = function(id){
  return id;
};

/**
 * Visit String.
 */

Evaluator.prototype.visitString = function(string){
  return string;
};

/**
 * Visit Null.
 */

Evaluator.prototype.visitNull = function(node){
  return node;
};

/**
 * Visit Function.
 */

Evaluator.prototype.visitFunction = function(fn){
  return fn;
};

/**
 * Visit RuleSet.
 */

Evaluator.prototype.visitRuleSet = function(set){
  for (var i = 0, len = set.nodes.length; i < len; ++i) {
    set.nodes[i] = this.visit(set.nodes[i]);
  }
  return set;
};


/**
 * Visit Selector.
 */

Evaluator.prototype.visitSelector = function(selector){
  selector.block = this.visit(selector.block);
  return selector;
};

/**
 * Visit Charset.
 */

Evaluator.prototype.visitCharset = function(charset){
  return charset;
};

/**
 * Visit Call.
 */

Evaluator.prototype.visitCall = function(call){
  // TODO: refactor
  var fn = this.lookupFunction(call.name);

  // Undefined function, render literal css
  if (!fn) {
    call.args = this.visit(call.args);
    return call;
  }

  // First node in expression
  if (fn instanceof nodes.Expression) {
    fn = fn.first;
  }

  var ret, body
    , params = fn.params
    , stack = this.stack;

  // Evaluate arguments
  var _ = this.return;
  this.return = true;
  var args = this.visit(call.args);
  this.return = _;

  // Built-in
  if ('function' == typeof fn) {
    args = args.nodes.map(function(node){
      return node.first;
    });
    body = fn.apply(this, args);
    if (!(body instanceof nodes.Expression)) {
      var expr = new nodes.Expression;
      expr.push(body);
      body = expr;
    }
  // User-defined
  } else if (fn instanceof nodes.Function) {
    body = fn.block.clone();

    // Inject arguments as locals
    stack.push(new Frame(body));
    params.nodes.forEach(function(node, i){
      node.val = args.nodes[i] || node.val;
      if (node.val instanceof nodes.Null) {
        throw new Error('argument ' + node + ' required for ' + fn);
      }
      stack.currentFrame.scope.add(node);
    });

    // Evaluate
    body = this.visit(body);
    stack.pop();
  } else {
    throw new Error('tried to call ' + call.name + '(), but cannot call non-function ' + fn.first);
  }

  // Return
  if (this.return) {
    ret = body.nodes[body.nodes.length - 1];
  // Mixin
  } else {
    body.nodes.forEach(function(node){
      stack.currentFrame.block.nodes.push(node);
    });
    ret = nodes.null;
  }

  return ret;
};

/**
 * Visit Variable.
 */

Evaluator.prototype.visitVariable = function(variable){
  // Lookup
  if (nodes.null == variable.val) {
    var val = this.stack.lookup(variable.name);
    if (!val) throw new Error('undefined variable ' + variable);
    return this.visit(val);
  // Assign  
  } else {
    variable.val = this.visit(variable.val);
    this.stack.currentFrame.scope.add(variable);
    return variable.val;
  }
};

/**
 * Visit BinOp.
 */

Evaluator.prototype.visitBinOp = function(binop){
  // Special-case "is defined" pseudo binop
  if ('is defined' == binop.op) return this.isDefined(binop.left);

  var _ = this.return;
  this.return = true;
  // Visit operands
  var op = binop.op
    , left = this.visit(binop.left).first
    , right = this.visit(binop.right).first;
  this.return = _;

  // Coercion
  var ignore = ['||', '&&', 'is a'];
  if (!~ignore.indexOf(op)) {
    right = left.coerce(right);
  }

  // Operate
  return this.visit(left.operate(op, right));
};

/**
 * Visit UnaryOp.
 */

Evaluator.prototype.visitUnaryOp = function(unary){
  var op = unary.op
    , node = this.visit(unary.expr).first;

  if ('!' != op) utils.assertType(node, nodes.Unit);

  switch (op) {
    case '-':
      node.val = -node.val;
      break;
    case '+':
      node.val = +node.val;
      break;
    case '~':
      node.val = ~node.val;
      break;
    case '!':
      return node.toBoolean().negate();
  }
  
  return node;
};

/**
 * Visit TernaryOp.
 */

Evaluator.prototype.visitTernary = function(ternary){
  var ok = this.visit(ternary.cond).toBoolean();
  return nodes.true == ok
    ? this.visit(ternary.trueExpr)
    : this.visit(ternary.falseExpr);
};

/**
 * Visit Expression.
 */

Evaluator.prototype.visitExpression = function(expr){
  for (var i = 0, len = expr.nodes.length; i < len; ++i) {
    expr.nodes[i] = this.visit(expr.nodes[i]);
  }
  return expr;
};

/**
 * Visit Property.
 */

Evaluator.prototype.visitProperty = function(prop){
  var fn = this.stack.lookup(prop.name)
    , call = fn instanceof nodes.Function
    , literal = prop.name == this.callingProperty;

  // Function of the same name
  if (call && !literal) {
    this.callingProperty = prop.name;
    var ret = this.visit(new nodes.Call(prop.name, prop.expr));
    this.callingProperty = null;
    return ret;
  // Regular property
  } else {
    var _ = this.return;
    this.return = true;
    prop.expr = this.visit(prop.expr);
    this.return = _;
  }
  return prop;
};

/**
 * Visit Import.
 */

Evaluator.prototype.visitImport = function(import){
  var found
    , root = this.root
    , i = this.rootIndex
    , stylus = require('../stylus')
    , path = import.path
    , relative = this.importPath;

  // Literal
  if (/\.css$/.test(path)) return import;
  path += '.styl';

  // Lookup
  if (relative) this.paths.push(relative);
  found = utils.lookup(path, this.paths);
  if (relative) this.paths.pop();

  // Throw if import failed
  if (!found) throw new Error('failed to locate @import file ' + path);
  this.importPath = dirname(found);

  // Parse the file
  var str = fs.readFileSync(found, 'utf8')
    , rest = root.nodes.splice(++i, root.nodes.length);

  stylus.parse(str, {
      filename: found
    , root: root
  });

  rest.forEach(function(node){
    root.push(node);
  });

  return nodes.null;
};

/**
 * Lookup function by the given `name`.
 *
 * @param {String} name
 * @return {Function}
 * @api public
 */

Evaluator.prototype.lookupFunction = function(name){
  return this.stack.lookup(name)
    || this.functions[name]
    || bifs[name];
};

/**
 * Check if the given `node` is a variable, and if it is defined.
 *
 * @param {Node} node
 * @return {Boolean}
 * @api private
 */

Evaluator.prototype.isDefined = function(node){
  if (node instanceof nodes.Variable) {
    return nodes.Boolean(this.stack.lookup(node.name));
  } else {
    throw new Error('invalid "is defined" check on non-variable ' + node);
  }
};