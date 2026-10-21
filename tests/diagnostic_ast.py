"""Narrow AST projection of the approved slice-1 diagnostic instrumentation.

Only the FIFO emit helper/calls, collector import/construction/add calls,
the pure matched-event diagnostic loop, the issues argument/return field,
and containers rendered empty by those removals are projected away.
Every other statement, including nested helpers, remains in the comparison.
"""
import ast
import hashlib


def dump(node):
    return ast.dump(node, include_attributes=False)


class DiagnosticProjection(ast.NodeTransformer):
    def visit_FunctionDef(self, node):
        if node.name == 'emit':
            # Pin the audited helper too; projection cannot hide a changed helper.
            assert hashlib.sha256(dump(node).encode()).hexdigest() == 'd128bf99c923a2430b4859565cb3fc4af6ceef6e19dbc2c00e322bed527183dc'
            return None
        if node.name == 'process_position':
            assert [x.arg for x in node.args.kwonlyargs] in ([], ['issues'])
            node.args.kwonlyargs = []
            node.args.kw_defaults = []
        return self.generic_visit(node)

    def visit_ImportFrom(self, node):
        if node.module == 'services.option_issues':
            assert [x.name for x in node.names] == ['IssueCollector', 'contract_scope']
            return None
        return node

    def visit_Assign(self, node):
        if dump(node.targets[0]) == dump(ast.Name(id='issues', ctx=ast.Store())):
            assert dump(node.value) == dump(ast.parse('IssueCollector()', mode='eval').body)
            return None
        return self.generic_visit(node)

    def visit_Expr(self, node):
        if isinstance(node.value, ast.Call):
            function = ast.unparse(node.value.func)
            if function in ('emit', 'issues.add'):
                return None
        return self.generic_visit(node)

    def visit_If(self, node):
        self.generic_visit(node)
        if not node.body:
            assert not node.orelse
            assert ast.unparse(node.test) in ("event.basis_status == 'unknown_transfer_basis'", 'c_warning')
            return None
        return node

    def visit_For(self, node):
        self.generic_visit(node)
        if not node.body:
            assert ast.unparse(node.target) == 'event'
            assert ast.unparse(node.iter) == "position_events[pos['id']]"
            assert not node.orelse
            return None
        return node

    def visit_Call(self, node):
        if ast.unparse(node.func) == 'process_position':
            node.keywords = [k for k in node.keywords if k.arg != 'issues']
        return self.generic_visit(node)

    def visit_Dict(self, node):
        pairs = [(k, v) for k, v in zip(node.keys, node.values)
                 if not (isinstance(k, ast.Constant) and k.value == 'issues'
                         and ast.unparse(v) == 'issues.as_list()')]
        node.keys = [k for k, _ in pairs]
        node.values = [v for _, v in pairs]
        return self.generic_visit(node)


def projected(source):
    return DiagnosticProjection().visit(ast.parse(source))


def fingerprints(source):
    module = projected(source)
    nodes = {'<entire module>': module}
    nodes.update({node.name: node for node in module.body if isinstance(node, ast.FunctionDef)})
    return {name: hashlib.sha256(dump(node).encode()).hexdigest() for name, node in nodes.items()}
