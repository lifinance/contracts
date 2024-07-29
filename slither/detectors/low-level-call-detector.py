from slither.core.cfg.node import NodeType
from slither.detectors.abstract_detector import AbstractDetector, DetectorClassification
import re

class LowLevelCallDetector(AbstractDetector):
    """
    Detects low-level calls (.call(...) or .call{value: ...}(...)) without a comment above
    stating "[slither: low-level call explicitly allowed]"
    """

    ARGUMENT = "low-level-call"  # slither will launch the detector with slither.py --detect low-level-call
    HELP = "Detects low-level calls without explicit comment allowance"
    IMPACT = DetectorClassification.HIGH
    CONFIDENCE = DetectorClassification.MEDIUM

    WIKI = "https://github.com/lifinance/contracts"
    WIKI_TITLE = "Low-level call without explicit allowance"
    WIKI_DESCRIPTION = "Low-level calls should have explicit comments allowing them to avoid potential security issues."
    WIKI_EXPLOIT_SCENARIO = "-"
    WIKI_RECOMMENDATION = "Add a comment [slither: low-level call explicitly allowed] above the low-level call if it is intended."

    def _detect(self):
        results = []
        low_level_call_pattern = re.compile(r'\.call(\{.*\})?\(.*\)')
        allowed_comment = "[slither: low-level call explicitly allowed]"

        for contract in self.compilation_unit.contracts_derived:
            for function in contract.functions_declared:
                for node in function.nodes:
                    if node.type == NodeType.EXPRESSION:
                        expression_str = str(node.expression)
                        if low_level_call_pattern.search(expression_str):
                            previous_node = self.get_previous_node(function, node)
                            if not previous_node or allowed_comment not in previous_node.source_mapping.get_source_code():
                                results.append(self.generate_result([f"Function {function.name} contains a low-level call: {expression_str} without explicit comment allowance"]))
        return results

    def get_previous_node(self, function, node):
        nodes = function.nodes
        node_index = nodes.index(node)
        if node_index > 0:
            return nodes[node_index - 1]
        return None
