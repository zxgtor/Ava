---
description: Search your local knowledge base
arguments:
  query:
    description: What to search for (natural language or keywords)
    required: true
  limit:
    description: "Max results (default: 5)"
    required: false
    default: "5"
---

# Knowledge Search

Search the local knowledge base for information relevant to this query:

**{{query}}**

Use the `knowledge_search` tool with the query above. If no results are found, let the user know their knowledge base may be empty and suggest using `knowledge_ingest` to add files.
