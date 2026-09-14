import ts from 'typescript';

import { IGNORED_GENERATE_OPT_PROPS } from './constants';
import { toSnakeCase } from './names';
import type {
  AnalyticsModel,
  EventCatalog,
  EventModel,
  PlatformConfig,
  PropertyType,
} from './types';

type ConstObject = Map<string, PropertyType>;

/**
 * Extracts catalog enum members and literal tracking call-site property bags.
 *
 * @param filePath - Path used in unresolved listings.
 * @param sourceText - TypeScript source at one SHA.
 * @param config - Platform catalog/enum names.
 * @param sharedCatalog - Enum members from the platform catalog file, so call sites in other files can resolve event names.
 * @returns Catalog map and per-event property models.
 */
export function extractAnalyticsModel(
  filePath: string,
  sourceText: string,
  config: PlatformConfig,
  sharedCatalog: EventCatalog | undefined = undefined,
): AnalyticsModel {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  const catalog: EventCatalog = new Map(sharedCatalog);
  for (const [key, name] of extractEnumCatalog(sourceFile, config.enumName)) {
    catalog.set(key, name);
  }
  const constObjects = collectConstObjects(sourceFile);
  const events = new Map<string, EventModel>();

  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }

    const callName = getCalledName(node);
    if (callName === 'createEventBuilder') {
      collectCreateEventBuilder(
        node,
        catalog,
        config,
        constObjects,
        filePath,
        events,
      );
      return;
    }

    if (callName === 'trackEvent') {
      collectTrackEvent(node, catalog, config, constObjects, filePath, events);
    }
  });

  return { catalog, events };
}

/**
 * Walks a node tree depth-first.
 *
 * @param node - Current node.
 * @param onNode - Visitor.
 */
function visit(node: ts.Node, onNode: (node: ts.Node) => void): void {
  onNode(node);
  ts.forEachChild(node, (child) => visit(child, onNode));
}

/**
 * Reads KEY -> display name from a string enum.
 *
 * @param sourceFile - Parsed source.
 * @param enumName - `EVENT_NAME` or `MetaMetricsEventName`.
 * @returns Catalog map.
 */
export function extractEnumCatalog(
  sourceFile: ts.SourceFile,
  enumName: string,
): EventCatalog {
  const catalog: EventCatalog = new Map();

  visit(sourceFile, (node) => {
    if (!ts.isEnumDeclaration(node) || node.name.text !== enumName) {
      return;
    }

    for (const member of node.members) {
      if (!ts.isIdentifier(member.name) || !member.initializer) {
        continue;
      }
      if (!ts.isStringLiteral(member.initializer)) {
        continue;
      }
      catalog.set(member.name.text, member.initializer.text);
    }
  });

  return catalog;
}

/**
 * Collects same-file `as const` object property types for identifier resolution.
 *
 * @param sourceFile - Parsed source.
 * @returns Object name -> property types.
 */
function collectConstObjects(
  sourceFile: ts.SourceFile,
): Map<string, ConstObject> {
  const objects = new Map<string, ConstObject>();

  visit(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) {
      return;
    }
    if (!node.initializer) {
      return;
    }

    let objectLiteral: ts.ObjectLiteralExpression | undefined;
    if (ts.isObjectLiteralExpression(node.initializer)) {
      objectLiteral = node.initializer;
    } else if (
      ts.isAsExpression(node.initializer) &&
      ts.isObjectLiteralExpression(node.initializer.expression)
    ) {
      objectLiteral = node.initializer.expression;
    }

    if (!objectLiteral) {
      return;
    }

    const props: ConstObject = new Map();
    for (const property of objectLiteral.properties) {
      if (!ts.isPropertyAssignment(property)) {
        continue;
      }
      const key = propertyName(property.name);
      if (!key) {
        continue;
      }
      const inferred = inferLiteralType(property.initializer, objects);
      if (inferred) {
        props.set(key, inferred);
      }
    }
    objects.set(node.name.text, props);
  });

  return objects;
}

/**
 * Records properties from createEventBuilder addProperties chains.
 *
 * @param node - The createEventBuilder call.
 * @param catalog - Enum catalog.
 * @param config - Platform config.
 * @param constObjects - Same-file const objects.
 * @param filePath - Source path.
 * @param events - Accumulator.
 */
function collectCreateEventBuilder(
  node: ts.CallExpression,
  catalog: EventCatalog,
  config: PlatformConfig,
  constObjects: Map<string, ConstObject>,
  filePath: string,
  events: Map<string, EventModel>,
): void {
  const eventName = resolveEventName(node.arguments[0], catalog, config);
  if (!eventName) {
    return;
  }

  const model = getOrCreateEvent(events, eventName);
  const chain = chainedCalls(node);

  for (const call of chain) {
    if (
      call.name !== 'addProperties' &&
      call.name !== 'addSensitiveProperties'
    ) {
      continue;
    }
    const bag = call.args[0];
    if (!bag) {
      continue;
    }
    mergeBag(bag, eventName, filePath, constObjects, model);
  }
}

/**
 * Records properties from trackEvent event/properties bags.
 *
 * @param node - The trackEvent call.
 * @param catalog - Enum catalog.
 * @param config - Platform config.
 * @param constObjects - Same-file const objects.
 * @param filePath - Source path.
 * @param events - Accumulator.
 */
function collectTrackEvent(
  node: ts.CallExpression,
  catalog: EventCatalog,
  config: PlatformConfig,
  constObjects: Map<string, ConstObject>,
  filePath: string,
  events: Map<string, EventModel>,
): void {
  const arg = node.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) {
    return;
  }

  let eventName: string | undefined;
  let propertiesNode: ts.Expression | undefined;

  for (const property of arg.properties) {
    if (!ts.isPropertyAssignment(property)) {
      if (ts.isSpreadAssignment(property) && !eventName) {
        return;
      }
      continue;
    }
    const key = propertyName(property.name);
    if (key === 'event') {
      eventName = resolveEventName(property.initializer, catalog, config);
    }
    if (key === 'properties') {
      propertiesNode = property.initializer;
    }
  }

  if (!eventName) {
    return;
  }

  const model = getOrCreateEvent(events, eventName);
  if (propertiesNode) {
    mergeBag(propertiesNode, eventName, filePath, constObjects, model);
  }
}

/**
 * Merges a property bag into the event model.
 *
 * @param bag - Object literal or other expression.
 * @param eventName - Event display name.
 * @param filePath - Source path.
 * @param constObjects - Same-file const objects.
 * @param model - Event accumulator.
 */
function mergeBag(
  bag: ts.Expression,
  eventName: string,
  filePath: string,
  constObjects: Map<string, ConstObject>,
  model: EventModel,
): void {
  if (!ts.isObjectLiteralExpression(bag)) {
    model.unresolved.push({
      eventName,
      key: '(non-literal properties)',
      file: filePath,
    });
    return;
  }

  for (const property of bag.properties) {
    if (ts.isSpreadAssignment(property)) {
      model.unresolved.push({
        eventName,
        key: '...',
        file: filePath,
      });
      continue;
    }

    if (ts.isShorthandPropertyAssignment(property)) {
      const snake = toSnakeCase(property.name.text);
      if (IGNORED_GENERATE_OPT_PROPS.has(snake)) {
        continue;
      }
      model.unresolved.push({
        eventName,
        key: snake,
        file: filePath,
      });
      continue;
    }

    if (!ts.isPropertyAssignment(property)) {
      continue;
    }

    const rawKey = propertyName(property.name);
    if (!rawKey) {
      continue;
    }
    const snake = toSnakeCase(rawKey);
    if (IGNORED_GENERATE_OPT_PROPS.has(snake)) {
      continue;
    }

    const inferred = inferLiteralType(property.initializer, constObjects);
    if (inferred) {
      const existing = model.properties.get(snake);
      if (!existing) {
        model.properties.set(snake, inferred);
      }
      continue;
    }

    model.unresolved.push({
      eventName,
      key: snake,
      file: filePath,
    });
  }
}

/**
 * Infers a Segment YAML type from a literal (or same-file const) expression.
 *
 * @param expression - Property value.
 * @param constObjects - Same-file const objects.
 * @returns Type, or undefined when the value is not a literal.
 */
function inferLiteralType(
  expression: ts.Expression,
  constObjects: Map<string, ConstObject>,
): PropertyType | undefined {
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return 'string';
  }
  if (ts.isNumericLiteral(expression)) {
    return 'number';
  }
  if (
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return 'boolean';
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return 'array';
  }
  if (
    ts.isPrefixUnaryExpression(expression) &&
    ts.isNumericLiteral(expression.operand)
  ) {
    return 'number';
  }

  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression)
  ) {
    const objectName = expression.expression.text;
    const object = constObjects.get(objectName);
    return object?.get(expression.name.text);
  }

  if (ts.isAsExpression(expression)) {
    return inferLiteralType(expression.expression, constObjects);
  }

  return undefined;
}

/**
 * Resolves a call argument to a catalog event display name.
 *
 * @param expression - First argument of createEventBuilder / event field.
 * @param catalog - Enum catalog.
 * @param config - Platform config.
 * @returns Display name, if it is a documented enum ref.
 */
function resolveEventName(
  expression: ts.Expression | undefined,
  catalog: EventCatalog,
  config: PlatformConfig,
): string | undefined {
  if (!expression) {
    return undefined;
  }

  if (ts.isStringLiteral(expression)) {
    return expression.text;
  }

  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression)
  ) {
    const objectName = expression.expression.text;
    const member = expression.name.text;
    if (
      objectName === config.enumName ||
      objectName === config.eventRefPrefix
    ) {
      return catalog.get(member);
    }
  }

  return undefined;
}

/**
 * Collects `.method()` calls chained off a call expression.
 *
 * @param start - Innermost call (createEventBuilder).
 * @returns Method names and arguments in chain order.
 */
function chainedCalls(
  start: ts.CallExpression,
): { name: string; args: readonly ts.Expression[] }[] {
  const calls: { name: string; args: readonly ts.Expression[] }[] = [];
  let current: ts.Node | undefined = start.parent;

  while (current) {
    if (
      ts.isPropertyAccessExpression(current) &&
      ts.isCallExpression(current.parent)
    ) {
      calls.push({
        name: current.name.text,
        args: current.parent.arguments,
      });
      current = current.parent.parent;
      continue;
    }
    break;
  }

  return calls;
}

/**
 * Returns the identifier name of a called function.
 *
 * @param node - Call expression.
 * @returns Function or method name.
 */
function getCalledName(node: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text;
  }
  if (ts.isPropertyAccessExpression(node.expression)) {
    return node.expression.name.text;
  }
  return undefined;
}

/**
 * Reads a property name from an identifier or string literal.
 *
 * @param name - Property name node.
 * @returns Text, if static.
 */
function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }
  return undefined;
}

/**
 * Returns the accumulator for an event name.
 *
 * @param events - Event map.
 * @param eventName - Display name.
 * @returns Existing or new model.
 */
function getOrCreateEvent(
  events: Map<string, EventModel>,
  eventName: string,
): EventModel {
  const existing = events.get(eventName);
  if (existing) {
    return existing;
  }
  const created: EventModel = {
    properties: new Map(),
    unresolved: [],
  };
  events.set(eventName, created);
  return created;
}

/**
 * Merges models from many files into one (catalog last-write-wins by key).
 *
 * @param models - Per-file models.
 * @returns Combined model.
 */
export function mergeAnalyticsModels(models: AnalyticsModel[]): AnalyticsModel {
  const catalog: EventCatalog = new Map();
  const events = new Map<string, EventModel>();

  for (const model of models) {
    for (const [key, name] of model.catalog) {
      catalog.set(key, name);
    }
    for (const [eventName, event] of model.events) {
      const target = getOrCreateEvent(events, eventName);
      for (const [key, type] of event.properties) {
        if (!target.properties.has(key)) {
          target.properties.set(key, type);
        }
      }
      target.unresolved.push(...event.unresolved);
    }
  }

  return { catalog, events };
}
