# Enterprise LLM Jailbreak Prompt Detection

## Overview

This was a three-person Applied Machine Learning (CPSC 461) project focused on building a lightweight guardrail for enterprise LLM systems. The system classifies prompts as **jailbreak** or **benign** before they are sent to an LLM, with the goal of reducing the risk of policy bypass, unsupported outputs, and other adversarial prompt behavior.

The project combined transformer fine-tuning with layer-wise embedding analysis to study not only whether jailbreak prompts could be detected, but also **where jailbreak-related structure emerges inside transformer representations**.

## Problem

Enterprise AI systems can receive adversarial prompts that attempt to bypass governance rules, expose sensitive information, or manipulate model behavior. Large security frameworks can be expensive or complex for smaller organizations, so the project explored a lighter-weight pre-execution guardrail.

## Dataset

- 5,000 labelled prompts
- Classes: jailbreak and benign
- Source: `qualifire/prompt-injections-benchmark`
- Train/validation split: 80/20
- 4,000 training samples
- 1,000 validation samples
- Fixed random seed: 42

## Models

The project evaluated:

- DistilBERT
- BERT-base-uncased

DistilBERT was used as a lighter baseline. The project later extended the approach to BERT-base-uncased to examine a deeper 12-layer transformer and improve classification performance.

## Team Results

### DistilBERT guardrail

- Accuracy: **89.4%**
- F1-score: **0.863**

### BERT-base-uncased

- Accuracy: **92.4%**
- F1-score: **0.905**

### Direction-based geometric classifier

The team derived a concept-direction vector representing the jailbreak axis in embedding space and evaluated a classifier that used geometric projection rather than additional learned weights.

- Accuracy: **88.0%**
- F1-score: **0.878**

### Hybrid classifier

The team combined the transformer classifier's softmax probability with a normalized geometric direction score.

- Accuracy: **90.3%**
- F1-score: **0.891**

## Layer-wise Analysis

The project extracted hidden-state representations from transformer layers and analyzed how jailbreak and benign prompts separated as representations moved deeper through the model.

Methods included:

- Mean and CLS pooling
- Centroid distance
- Cosine similarity
- Principal Component Analysis (PCA)
- Within-class and between-class distance analysis
- Truncated Singular Value Decomposition (SVD)
- Concept-direction analysis

The analysis found that jailbreak and benign prompts became more separable in later transformer layers. In the DistilBERT analysis, centroid distance increased from **1.74 at layer 0 to 8.16 at layer 6**, while cosine similarity decreased from **0.886 to 0.663**.

The team also used SVD on difference vectors between benign and jailbreak embeddings to identify human-interpretable vocabulary associated with manipulation patterns.

## My Contribution

The overall classifier, BERT extension, hybrid model, paper, and final results were **team outcomes**.

My specific contribution was the **model-agnostic layer-wise probing pipeline**. I designed and implemented the analysis used to inspect transformer representations across layers and quantify where jailbreak and benign prompts became separable.

My work included:

- Building the layer-wise probing workflow for DistilBERT representations
- Comparing jailbreak and benign embedding geometry across transformer depth
- Computing and analyzing centroid distance and cosine similarity
- Using PCA to visualize class separation
- Making the probing approach model-agnostic so the analysis could be extended beyond a single transformer implementation
- Evaluating separability and interpreting how representation structure changed across layers

My layer-wise analysis reached approximately **89% accuracy and a 0.87 F1-score** in the DistilBERT work.

## Architecture

```text
User Prompt
    |
    v
Tokenizer
    |
    v
Fine-tuned Transformer
    |------------------------------|
    |                              |
    v                              v
Classification Head          Hidden States
    |                              |
Softmax Probability                v
                           Layer-wise Analysis
                           - Centroids
                           - Cosine similarity
                           - PCA
                           - Difference vectors
                                  |
                                  v
                         Direction Score
    |                              |
    |--------------+---------------|
                   |
                   v
             Hybrid Detection
                   |
                   v
          Jailbreak / Benign
```

## Technology Stack

- Python 3.10 / 3.11
- PyTorch
- Hugging Face Transformers
- Hugging Face Datasets
- scikit-learn
- NumPy
- pandas
- matplotlib
- DistilBERT
- BERT-base-uncased
- CUDA
- Git

## Training Configuration

The reported experiments used:

- AdamW optimizer
- Learning rate: `2e-5`
- Weight decay: `0.01`
- Warmup ratio: `0.1`
- Training batch size: `32`
- Evaluation batch size: `64`
- FP16 mixed precision
- Maximum sequence length: `128`
- Early stopping based on validation F1-score

## Key Takeaways

- A relatively lightweight transformer can provide useful pre-execution jailbreak detection.
- Jailbreak-related information becomes increasingly structured and separable in later transformer layers.
- Embedding geometry can provide additional signal beyond the classifier's softmax probability.
- Layer-wise probing provides an explainability mechanism for understanding how the model represents adversarial intent.

## Limitations

- Only one 5,000-prompt dataset was used.
- The task contained only two classes: benign and jailbreak.
- Generalization across multiple datasets and model families was not fully tested.
- The system detects suspicious prompts but does not itself prevent or neutralize an attack.
- Approximately 90% detection performance is not sufficient to guarantee protection against determined attackers.
- The project did not implement continuous or incremental retraining.

## Future Work

Potential extensions include:

- Testing on additional datasets and model architectures
- Adding harmful/toxic prompt categories
- Generating more varied attacks through red teaming
- Exploring lightweight incremental retraining
- Combining multiple specialized guardrail models
- Testing the detector as middleware in a deployed LLM application

## Course

**CPSC 461 — Applied Machine Learning**  
University of Northern British Columbia

## Team

Three-person team:

- Josh Holuboch
- Yamin Xu
- Zohaib Rahim
