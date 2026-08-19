#!/usr/bin/env python3
"""Constrained symbolic/numeric verification for Metis MCP."""

from __future__ import annotations

import ast
import json
import math
import sys
from decimal import Decimal, InvalidOperation, localcontext
from fractions import Fraction
from typing import Any, Callable

try:
    import sympy
except ImportError:
    sympy = None


PI = Decimal(
    "3.141592653589793238462643383279502884197169399375105820974944592307816406286"
)
E = Decimal(
    "2.718281828459045235360287471352662497757247093699959574966967627724076630353"
)


class DecimalExpressionBuilder(ast.NodeVisitor):
    def __init__(
        self,
        variables: dict[str, Any],
        precision: int,
        symbol_values: dict[str, Decimal] | None = None,
    ) -> None:
        self.precision = precision
        self.variables = {
            name: Decimal(str(value))
            for name, value in variables.items()
            if name.isidentifier()
        }
        if len(self.variables) != len(variables):
            raise ValueError("Every variable name must be a valid identifier.")
        self.symbol_values = symbol_values or {}
        self.warnings: list[str] = []

    def build(self, expression: str) -> Decimal:
        if len(expression) > 2000:
            raise ValueError("Expression exceeds the 2000-character safety limit.")
        tree = ast.parse(expression.strip().replace("^", "**"), mode="eval")
        with localcontext() as context:
            context.prec = self.precision + 12
            return +self.visit(tree.body)

    def visit_Constant(self, node: ast.Constant) -> Decimal:
        if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
            raise ValueError("Only numeric constants are allowed.")
        return Decimal(str(node.value))

    def visit_Name(self, node: ast.Name) -> Decimal:
        if node.id in self.symbol_values:
            return self.symbol_values[node.id]
        if node.id in self.variables:
            return self.variables[node.id]
        if node.id == "pi":
            return PI
        if node.id == "tau":
            return 2 * PI
        if node.id == "e":
            return E
        raise ValueError(f"Unknown variable '{node.id}'. Supply it in variables.")

    def visit_BinOp(self, node: ast.BinOp) -> Decimal:
        left = self.visit(node.left)
        right = self.visit(node.right)
        if isinstance(node.op, ast.Add):
            return left + right
        if isinstance(node.op, ast.Sub):
            return left - right
        if isinstance(node.op, ast.Mult):
            return left * right
        if isinstance(node.op, ast.Div):
            return left / right
        if isinstance(node.op, ast.FloorDiv):
            return left // right
        if isinstance(node.op, ast.Mod):
            return left % right
        if isinstance(node.op, ast.Pow):
            if right == right.to_integral_value():
                return left ** int(right)
            if left <= 0:
                raise ValueError("Fractional powers require a positive real base.")
            return (right * left.ln()).exp()
        raise ValueError(f"Operator {type(node.op).__name__} is not allowed.")

    def visit_UnaryOp(self, node: ast.UnaryOp) -> Decimal:
        operand = self.visit(node.operand)
        if isinstance(node.op, ast.UAdd):
            return operand
        if isinstance(node.op, ast.USub):
            return -operand
        raise ValueError(f"Unary operator {type(node.op).__name__} is not allowed.")

    def visit_Call(self, node: ast.Call) -> Decimal:
        if not isinstance(node.func, ast.Name):
            raise ValueError("Only direct calls to allow-listed functions are allowed.")
        if node.keywords:
            raise ValueError("Keyword arguments are not allowed.")
        arguments = [self.visit(argument) for argument in node.args]
        functions: dict[str, Callable[..., Decimal]] = {
            "abs": lambda value: abs(value),
            "ceil": lambda value: Decimal(math.ceil(value)),
            "exp": lambda value: value.exp(),
            "floor": lambda value: Decimal(math.floor(value)),
            "ln": lambda value: value.ln(),
            "log": self._log,
            "log10": lambda value: value.log10(),
            "max": lambda *values: max(values),
            "min": lambda *values: min(values),
            "sqrt": lambda value: value.sqrt(),
            "sin": lambda value: self._float_transcendental("sin", math.sin, value),
            "cos": lambda value: self._float_transcendental("cos", math.cos, value),
            "tan": lambda value: self._float_transcendental("tan", math.tan, value),
            "asin": lambda value: self._float_transcendental("asin", math.asin, value),
            "acos": lambda value: self._float_transcendental("acos", math.acos, value),
            "atan": lambda value: self._float_transcendental("atan", math.atan, value),
        }
        function = functions.get(node.func.id)
        if function is None:
            raise ValueError(f"Function '{node.func.id}' is not allowed.")
        return function(*arguments)

    def generic_visit(self, node: ast.AST) -> Decimal:
        raise ValueError(f"Syntax {type(node).__name__} is not allowed.")

    def _log(self, value: Decimal, base: Decimal | None = None) -> Decimal:
        return value.ln() if base is None else value.ln() / base.ln()

    def _float_transcendental(
        self,
        name: str,
        function: Callable[[float], float],
        value: Decimal,
    ) -> Decimal:
        warning = (
            f"{name} used Python's correctly rounded binary float implementation; "
            "effective precision is about 15 decimal digits without SymPy."
        )
        if warning not in self.warnings:
            self.warnings.append(warning)
        return Decimal(str(function(float(value))))


if sympy is not None:
    class SympyExpressionBuilder(ast.NodeVisitor):
        def __init__(self, variables: dict[str, Any]) -> None:
            self.variables = {
                name: sympy.sympify(str(value), rational=True)
                for name, value in variables.items()
                if name.isidentifier()
            }
            if len(self.variables) != len(variables):
                raise ValueError("Every variable name must be a valid identifier.")

        def build(self, expression: str) -> Any:
            if len(expression) > 2000:
                raise ValueError("Expression exceeds the 2000-character safety limit.")
            tree = ast.parse(expression.strip().replace("^", "**"), mode="eval")
            return self.visit(tree.body)

        def visit_Constant(self, node: ast.Constant) -> Any:
            if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
                raise ValueError("Only numeric constants are allowed.")
            return sympy.Rational(str(node.value))

        def visit_Name(self, node: ast.Name) -> Any:
            if node.id in self.variables:
                return self.variables[node.id]
            constants = {"e": sympy.E, "pi": sympy.pi, "tau": 2 * sympy.pi}
            if node.id in constants:
                return constants[node.id]
            return sympy.Symbol(node.id, real=True)

        def visit_BinOp(self, node: ast.BinOp) -> Any:
            left = self.visit(node.left)
            right = self.visit(node.right)
            if isinstance(node.op, ast.Add):
                return left + right
            if isinstance(node.op, ast.Sub):
                return left - right
            if isinstance(node.op, ast.Mult):
                return left * right
            if isinstance(node.op, ast.Div):
                return left / right
            if isinstance(node.op, ast.FloorDiv):
                return sympy.floor(left / right)
            if isinstance(node.op, ast.Mod):
                return sympy.Mod(left, right)
            if isinstance(node.op, ast.Pow):
                return left**right
            raise ValueError(f"Operator {type(node.op).__name__} is not allowed.")

        def visit_UnaryOp(self, node: ast.UnaryOp) -> Any:
            operand = self.visit(node.operand)
            if isinstance(node.op, ast.UAdd):
                return operand
            if isinstance(node.op, ast.USub):
                return -operand
            raise ValueError(f"Unary operator {type(node.op).__name__} is not allowed.")

        def visit_Call(self, node: ast.Call) -> Any:
            if not isinstance(node.func, ast.Name) or node.keywords:
                raise ValueError("Only direct calls to allow-listed functions are allowed.")
            functions = {
                "abs": sympy.Abs,
                "acos": sympy.acos,
                "asin": sympy.asin,
                "atan": sympy.atan,
                "ceil": sympy.ceiling,
                "cos": sympy.cos,
                "exp": sympy.exp,
                "floor": sympy.floor,
                "ln": sympy.log,
                "log": sympy.log,
                "log10": lambda value: sympy.log(value, 10),
                "max": sympy.Max,
                "min": sympy.Min,
                "sin": sympy.sin,
                "sqrt": sympy.sqrt,
                "tan": sympy.tan,
            }
            function = functions.get(node.func.id)
            if function is None:
                raise ValueError(f"Function '{node.func.id}' is not allowed.")
            return function(*[self.visit(argument) for argument in node.args])

        def generic_visit(self, node: ast.AST) -> Any:
            raise ValueError(f"Syntax {type(node).__name__} is not allowed.")


def sympy_result(value: Any, precision: int) -> dict[str, Any]:
    simplified = sympy.simplify(value)
    numeric = sympy.N(simplified, precision)
    return {
        "exact": str(simplified),
        "decimal": str(numeric),
        "latex": sympy.latex(simplified),
        "isReal": bool(simplified.is_real) if simplified.is_real is not None else None,
    }


def decimal_result(
    value: Decimal,
    precision: int,
    exact: str | None = None,
) -> dict[str, Any]:
    with localcontext() as context:
        context.prec = precision
        rounded = +value
    return {
        "exact": exact or decimal_fraction(value),
        "decimal": str(rounded),
        "latex": exact_to_latex(exact or decimal_fraction(value)),
        "isReal": True,
    }


def decimal_fraction(value: Decimal) -> str:
    fraction = Fraction(value)
    if fraction.denominator == 1:
        return str(fraction.numerator)
    if fraction.denominator <= 10**12:
        return f"{fraction.numerator}/{fraction.denominator}"
    return str(value)


def exact_to_latex(value: str) -> str:
    if value.count("/") == 1:
        numerator, denominator = value.split("/")
        if numerator.lstrip("-").isdigit() and denominator.isdigit():
            sign = "-" if numerator.startswith("-") else ""
            return f"{sign}\\frac{{{numerator.lstrip('-')}}}{{{denominator}}}"
    return value.replace("*", r"\cdot ")


def fallback_solve(
    expression: str,
    symbol_name: str,
    variables: dict[str, Any],
    precision: int,
    initial_guess: Any,
) -> tuple[list[dict[str, Any]], list[str], str]:
    if expression.count("=") != 1:
        raise ValueError("A solve expression must contain exactly one '='.")
    left_text, right_text = expression.split("=", 1)
    warnings: list[str] = []

    def evaluate(value: Decimal) -> Decimal:
        left_builder = DecimalExpressionBuilder(
            variables, precision, {symbol_name: value}
        )
        right_builder = DecimalExpressionBuilder(
            variables, precision, {symbol_name: value}
        )
        result = left_builder.build(left_text) - right_builder.build(right_text)
        for warning in left_builder.warnings + right_builder.warnings:
            if warning not in warnings:
                warnings.append(warning)
        return result

    with localcontext() as context:
        context.prec = precision + 12
        zero = Decimal(0)
        one = Decimal(1)
        two = Decimal(2)
        f0, f1, f2 = evaluate(zero), evaluate(one), evaluate(two)
        scale = max(Decimal(1), abs(f0), abs(f1), abs(f2))
        tolerance = Decimal(10) ** (-(min(precision, 40) - 5))
        second_difference = f2 - 2 * f1 + f0

        if abs(second_difference) <= scale * tolerance:
            slope = f1 - f0
            if abs(slope) <= tolerance:
                raise ValueError("Equation is constant or underdetermined in the requested variable.")
            root = -f0 / slope
            if abs(evaluate(root)) > scale * tolerance * 10:
                raise ValueError("Linear fallback could not verify the computed root.")
            return [decimal_result(root, precision)], warnings, "linear exact interpolation"

        a = second_difference / 2
        b = f1 - a - f0
        c = f0
        f3 = evaluate(Decimal(3))
        predicted_f3 = a * 9 + b * 3 + c
        if abs(f3 - predicted_f3) <= max(scale, abs(f3)) * tolerance:
            discriminant = b * b - 4 * a * c
            if discriminant < 0:
                return [], warnings, "quadratic formula over real numbers"
            square_root = discriminant.sqrt()
            roots = [(-b + square_root) / (2 * a)]
            if square_root != 0:
                roots.append((-b - square_root) / (2 * a))
            for root in roots:
                if abs(evaluate(root)) > max(scale, abs(root)) * tolerance * 100:
                    raise ValueError("Quadratic fallback could not verify a computed root.")
            return (
                [decimal_result(root, precision) for root in roots],
                warnings,
                "quadratic formula",
            )

        guess = Decimal(str(initial_guess))
        h = Decimal(10) ** (-(min(precision, 30) // 2))
        root = guess
        for _ in range(100):
            value = evaluate(root)
            if abs(value) <= tolerance:
                break
            derivative = (evaluate(root + h) - evaluate(root - h)) / (2 * h)
            if abs(derivative) <= tolerance:
                raise ValueError(
                    "Numerical derivative vanished. Provide a different initialGuess or install SymPy."
                )
            next_root = root - value / derivative
            if abs(next_root - root) <= tolerance:
                root = next_root
                break
            root = next_root
        residual = abs(evaluate(root))
        if residual > tolerance * 100:
            raise ValueError(
                f"Newton fallback did not verify a root; residual was {residual}. "
                "Provide a better initialGuess or install SymPy."
            )
        return [decimal_result(root, precision)], warnings, "Newton iteration with residual check"


def main() -> None:
    try:
        payload = (
            json.loads(sys.argv[1])
            if len(sys.argv) > 1
            else json.load(sys.stdin)
        )
        operation = payload.get("operation", "evaluate")
        expression = str(payload["expression"])
        variables = payload.get("variables", {})
        precision = int(payload.get("precision", 30))
        if not 10 <= precision <= 100:
            raise ValueError("precision must be between 10 and 100 digits.")
        if not isinstance(variables, dict):
            raise ValueError("variables must be an object.")

        if sympy is not None:
            builder = SympyExpressionBuilder(variables)
            if operation == "evaluate":
                value = builder.build(expression)
                output = {
                    "ok": True,
                    "operation": operation,
                    "expression": expression,
                    "variables": variables,
                    "result": sympy_result(value, precision),
                    "verifiedBy": (
                        f"Python {sys.version_info.major}.{sys.version_info.minor} "
                        f"+ SymPy {sympy.__version__}"
                    ),
                }
            elif operation == "solve":
                symbol_name = str(payload.get("solveFor", "")).strip()
                if not symbol_name.isidentifier():
                    raise ValueError("solveFor must be a valid variable name.")
                if expression.count("=") != 1:
                    raise ValueError("A solve expression must contain exactly one '='.")
                left_text, right_text = expression.split("=", 1)
                equation = sympy.Eq(builder.build(left_text), builder.build(right_text))
                symbol = sympy.Symbol(symbol_name, real=True)
                solutions = sympy.solve(equation, symbol)
                output = {
                    "ok": True,
                    "operation": operation,
                    "expression": expression,
                    "solveFor": symbol_name,
                    "variables": variables,
                    "solutions": [
                        sympy_result(solution, precision) for solution in solutions
                    ],
                    "method": "symbolic solve",
                    "verifiedBy": (
                        f"Python {sys.version_info.major}.{sys.version_info.minor} "
                        f"+ SymPy {sympy.__version__}"
                    ),
                }
            else:
                raise ValueError("operation must be 'evaluate' or 'solve'.")
        else:
            if operation == "evaluate":
                builder = DecimalExpressionBuilder(variables, precision)
                value = builder.build(expression)
                output = {
                    "ok": True,
                    "operation": operation,
                    "expression": expression,
                    "variables": variables,
                    "result": decimal_result(
                        value,
                        precision,
                        exact=expression.replace("**", "^"),
                    ),
                    "warnings": builder.warnings,
                    "verifiedBy": (
                        f"Python {sys.version_info.major}.{sys.version_info.minor} "
                        "decimal/ast standard-library engine"
                    ),
                }
            elif operation == "solve":
                symbol_name = str(payload.get("solveFor", "")).strip()
                if not symbol_name.isidentifier():
                    raise ValueError("solveFor must be a valid variable name.")
                solutions, warnings, method = fallback_solve(
                    expression,
                    symbol_name,
                    variables,
                    precision,
                    payload.get("initialGuess", 0),
                )
                output = {
                    "ok": True,
                    "operation": operation,
                    "expression": expression,
                    "solveFor": symbol_name,
                    "variables": variables,
                    "solutions": solutions,
                    "method": method,
                    "warnings": warnings,
                    "verifiedBy": (
                        f"Python {sys.version_info.major}.{sys.version_info.minor} "
                        "decimal/ast standard-library engine"
                    ),
                }
            else:
                raise ValueError("operation must be 'evaluate' or 'solve'.")
    except (ValueError, SyntaxError, InvalidOperation, ZeroDivisionError) as exc:
        output = {
            "ok": False,
            "error": str(exc),
            "errorType": type(exc).__name__,
        }
    except Exception as exc:
        output = {
            "ok": False,
            "error": str(exc),
            "errorType": type(exc).__name__,
        }
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
