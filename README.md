# C++ Class Insight

This tool visualizes the hierarchy of C++ classes in your project. It generates three types of class hierarchy diagrams:

- Overall Class Hierarchy
- Base Class Hierarchy
- Derived Class Hierarchy

## Prerequisites

- `clangd` (C++ language server)

## Usage

1. Place your cursor on a target class.
2. Open the command palette by pressing `Shift + Ctrl + P`.
3. Select one of the following commands:
   - **Show Class Hierarchy**: Displays the entire class hierarchy.
   - **Show Class Hierarchy - Supertypes**: Displays the base class hierarchy (supertypes).
   - **Show Class Hierarchy - Subtypes**: Displays the derived class hierarchy (subtypes).

## How it works

This tool uses `clangd` (derived from vscode language server model) and the Mermaid diagram generator to create class hierarchy diagrams.

Enjoy visualizing your C++ class hierarchies!