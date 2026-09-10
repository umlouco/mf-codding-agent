package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"reflect"
	"strconv"
	"testing"
)

// Golden transport metadata predates the handler extraction. Moving code must
// not change a method name, handler binding, or which requests run asynchronously.
func TestServerRPCRegistrationContract(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "main.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	ast.Inspect(file, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok || len(call.Args) != 2 {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || (selector.Sel.Name != "Register" && selector.Sel.Name != "RegisterAsync") {
			return true
		}
		literal, ok := call.Args[0].(*ast.BasicLit)
		if !ok {
			t.Fatal("RPC method is no longer a literal")
		}
		method, err := strconv.Unquote(literal.Value)
		if err != nil {
			t.Fatal(err)
		}
		handler := "inline"
		if binding, ok := call.Args[1].(*ast.SelectorExpr); ok {
			handler = binding.Sel.Name
		}
		got[method] = selector.Sel.Name + ":" + handler
		return true
	})
	want := map[string]string{
		"initialize":          "Register:onInitialize",
		"chat/send":           "RegisterAsync:onSend",
		"chat/cancel":         "Register:onCancel",
		"chat/steer":          "Register:onSteer",
		"chat/reset":          "Register:onReset",
		"tools/list":          "Register:onToolsList",
		"tools/invoke":        "RegisterAsync:onToolsInvoke",
		"memory/stats":        "Register:onMemoryStats",
		"memory/graph":        "Register:onMemoryGraph",
		"memory/search":       "Register:onMemorySearch",
		"memory/forget":       "Register:onMemoryForget",
		"memory/lessons":      "Register:onMemoryLessons",
		"memory/lessonUpsert": "Register:onMemoryLessonUpsert",
		"memory/lessonDelete": "Register:onMemoryLessonDelete",
		"mcp/status":          "Register:onMCPStatus",
		"browser/close":       "Register:onBrowserClose",
		"shutdown":            "Register:inline",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("RPC metadata changed: got %#v want %#v", got, want)
	}
}

func TestInitializeResultJSONContract(t *testing.T) {
	got := map[string]string{}
	typeInfo := reflect.TypeOf(initResult{})
	for i := 0; i < typeInfo.NumField(); i++ {
		field := typeInfo.Field(i)
		got[field.Name] = field.Tag.Get("json")
	}
	want := map[string]string{
		"Version": "version", "Provider": "provider", "Model": "model", "Tools": "tools",
		"Memory": "memory", "Cognition": "cognition", "MemPath": "memoryPath,omitempty",
		"Vision": "visionModel,omitempty", "Embedding": "embeddingModel,omitempty",
		"MCP": "mcp,omitempty", "EditorTools": "editorTools,omitempty", "Warnings": "warnings,omitempty",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("initialization metadata changed: got %#v want %#v", got, want)
	}
}
